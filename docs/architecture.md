# Arquitetura

Threadmark é o sistema operacional local de suporte. Ele captura mensagens inbound, preserva o histórico, organiza a triagem e mantém tickets, usuários, categorias, automações internas e métricas. Hermes — ou outro agente compatível — é a superfície conversacional e a camada de modelos, skills e ferramentas externas.

```text
WhatsApp / Baileys (somente entrada)
  -> normalização, aliases e deduplicação
  -> SQLite + anexos privados
      -> conversas e Diretório
      -> fila de triagem
      -> sugestões revisáveis
      -> tickets como recortes explícitos
      -> Kanban, métricas e automações internas

Threadmark Web
  -> API privada no mesmo runtime
  -> revisão visual, separação de assuntos e operação do suporte

Hermes / modelo / skills
  -> CLI threadmark
      -> API autenticada
          -> regras de domínio, permissões, auditoria e SQLite
  -> Git, Linear, AWS, bancos readonly e outras ferramentas do agente
```

## Processos

- Web UI: `http://127.0.0.1:3000` pelo código-fonte ou porta `3000` do container.
- API: `http://127.0.0.1:4317`; no container, a Web encaminha `/api/*` e `/health` para essa porta privada.
- Daemon: captura, heartbeat, scheduler, transcrição local opcional e automações internas.
- CLI: fachada de domínio versionada para operação humana e agentes externos.
- Executor semântico de triagem: Hermes externo pela CLI; `SUPPORT_TRIAGE_AI_ENABLED=false` mantém o classificador determinístico local.

Pelo código-fonte, os listeners usam loopback por padrão. No container, somente a Web aceita conexões em `0.0.0.0`; a API continua em loopback e é acessada pelo proxy same-origin da Web. `SUPPORT_PUBLIC_ORIGIN` define a origem HTTPS aceita para CORS, CSRF e cookies.

## Persistência

SQLite é a fonte de verdade para contas, participantes, grupos, mensagens, tickets, categorias, jobs, auditoria e configuração operacional. Anexos são arquivos locais referenciados pelo banco.

Mensagens nunca são copiadas para dentro de um ticket. `ticket_messages` registra um recorte explícito da conversa original, permitindo separar assuntos no mesmo grupo sem duplicação nem perda de contexto.

O banco, WAL/SHM, anexos, autenticação do WhatsApp, segredos e logs ficam sob `SUPPORT_DATA_DIR` e não entram no Git. Skills, memória, credenciais e integrações específicas da organização pertencem ao perfil privado do agente e também não entram no SQLite do Threadmark.

Áudios OGG/Opus podem ser transcritos por um worker local opcional. O arquivo original é preservado, e o cache do modelo local fica no diretório privado de dados.

O modelo e a inferência rodam em um processo filho dedicado. Cada carregamento local ou transcrição tem prazo de 10 minutos, configurável por `SUPPORT_AUDIO_TRANSCRIPTION_TIMEOUT_MS` (inteiro positivo em milissegundos); a instalação inicial tem prazo de 30 minutos. O prazo é total por operação, não é renovado por callbacks de progresso. Ao expirar, o daemon encerra o processo e aguarda sua saída antes de registrar o áudio como `failed` e seguir para o próximo. O original permanece disponível para reprodução e tentativa manual. Erros e quedas do processo também ficam registrados no áudio; uma nova operação cria outro processo quando necessário.

O encerramento do daemon interrompe a inferência sem esperar esse prazo. Um áudio interrompido pode ser retomado até completar três tentativas entre reinicializações; depois fica como `failed` e deixa de entrar automaticamente na fila. Uma ação manual de tentar novamente inicia um novo orçamento de tentativas. Falhas por timeout não são repetidas automaticamente. O modelo continua sendo liberado após dois minutos sem uso.

## Fronteira headless

A CLI nunca orienta o agente a consultar ou alterar o SQLite diretamente. `threadmark capabilities --json` publica um contrato versionado com operações, limites e requisitos de autorização.

- Leituras são limitadas, paginadas e podem ser usadas sem confirmação adicional.
- Escritas exigem `--apply`, uma identidade ativa com `--as` e, quando útil, `--client`.
- A API valida papel, IDs, transições, tamanho de entrada e idempotência.
- Criações repetidas usam `clientRequestId` estável.
- Conteúdo extenso entra por arquivo privado ou stdin, não por argumento de processo.
- O token local é lido internamente pela CLI e nunca entregue ao modelo.
- WhatsApp outbound e SQL direto não existem no contrato.

O envelope JSON `threadmark.headless.v1` permite que Hermes e outros agentes usem a mesma API sem depender de detalhes internos.

## Identidade e auditoria

Toda escrita headless resolve `--as` para um usuário ativo do workspace. O ator persistido identifica a pessoa e o cliente executor. A API aplica as mesmas permissões usadas pela interface.

Os endpoints privados de execução externa aceitam somente a identidade de agente esperada. Claim, heartbeat e conclusão de triagem são auditáveis e usam lease; um job abandonado pode ser recuperado sem um executor interno de modelos concorrente.

## Fronteira inbound-only

O conector aceita histórico, novas mensagens, anexos, reações, respostas citadas, roster e metadados necessários. Não existe método de envio, composer, rota ou comando outbound.

Mensagens da equipe são persistidas como contexto. Apenas participantes externos podem originar candidatos, e uma sugestão nunca cria ou modifica um ticket sem decisão humana.

## Estados de triagem

Mensagens ficam em `unreviewed`, `ticketed`, `ignored` ou `context`. O classificador pode agrupar mensagens e sugerir `create`, `attach`, `ignore` ou `wait`, mas a decisão final permanece com o operador.

Uma mensagem externa inicia uma janela de silêncio configurável. Ao final, o scheduler persiste um job idempotente com um recorte limitado da conversa, tickets abertos, sugestões pendentes e catálogo de categorias.

No modo externo:

1. o monitor consulta somente o estado da fila;
2. o Hermes reivindica o job por lease;
3. recebe o recorte validado, não o banco;
4. devolve JSON conforme o mesmo schema de triagem;
5. o domínio valida cobertura, referências e categorias;
6. a interface mostra a sugestão para revisão.

Mesmo um `attach` de alta confiança vindo do executor externo não anexa mensagens automaticamente. O operador pode separar assuntos, ajustar categorias, criar, anexar, ignorar ou manter o conteúdo como contexto.

`wait` não cria card e permanece até chegar novo contexto ou o operador pedir nova análise. Se a conversa mudar durante a execução, o resultado é invalidado.

## Estados do ticket

- `new`: novo recorte confirmado.
- `triage`: em revisão.
- `in_progress`: investigação ou resposta em preparação.
- `waiting_customer`: aguardando o solicitante.
- `blocked`: aguardando dependência interna.
- `resolved`: resolvido manualmente.
- `cancelled`: encerrado sem resolução.
- `archived`: ocultado das visões ativas sem apagar o histórico.

Resolvidos e cancelados podem ser arquivados; ao restaurar, o histórico devolve cada ticket ao estado terminal anterior.

## Motor de automações

O Threadmark mantém fluxos internos determinísticos ligados ao ciclo de vida dos tickets. Definições, eventos, execuções, etapas, waits, aprovações e leases ficam no SQLite. Ações usam idempotência estável, e eventos derivados não retornam ao motor para evitar loops.

A interface oferece apenas o catálogo interno. Definições antigas com nós de apps externos continuam legíveis para não corromper fluxos existentes, mas novos apps e ferramentas são configurados e operados no Hermes. O WhatsApp permanece inbound-only em ambos os caminhos.

## Diretório

O Diretório expõe grupos e pessoas sincronizados do WhatsApp. Grupos preservam JID, participantes, monitoramento, atividade e tickets relacionados. Pessoas preservam autoria, telefone, aliases PN/LID, participação em grupos e identificação da equipe.

Categorias, prioridade e responsável organizam os tickets sem alterar as mensagens originais.

## API principal

As rotas autenticadas exigem a sessão local apropriada. Os payloads completos ficam em `shared/contracts.ts`.

### Runtime e configuração

- `GET /health`
- `GET /api/runtime/identity` e `POST /api/runtime/shutdown`
- `GET /api/runtime`
- `GET /api/settings/workspace` e `PATCH /api/settings/workspace`
- `GET /api/settings/staff` e `PUT /api/settings/staff`
- `POST /api/settings/backup`

### Conversas, triagem e tickets

- `GET /api/conversations`
- `GET /api/conversations/:id/messages`
- `GET /api/conversations/:id/triage-blocks`
- `POST /api/conversations/:id/triage/analyze`
- `POST /api/conversations/:id/triage/tickets`
- `POST /api/conversations/:id/triage/attach`
- `POST /api/conversations/:id/triage/ignore`
- `POST /api/conversations/:id/triage/context`
- `POST /api/conversations/:id/triage/restore`
- `GET /api/tickets` e `GET /api/tickets/:id`
- operações tipadas de status, contexto, responsável, categorias e notas

### Executor externo

- `GET /api/agent/triage/jobs`
- `POST /api/agent/triage/jobs/claim`
- `POST /api/agent/triage/jobs/:id/heartbeat`
- `POST /api/agent/triage/jobs/:id/complete`

### Diretório, dashboard e automações internas

- `GET /api/directory`
- `GET /api/dashboard` e `GET /api/dashboard/export`
- rotas de workflows, execuções, aprovações e notificações internas

O dashboard usa o mesmo período e filtro de responsável na visão e no CSV. O valor reservado `unassigned` representa tickets sem responsável.

## Compatibilidade legada

O runtime Threadmark AI foi aposentado: não há chat, provider router, Codex interno, tool bridge, investigation workers ou endpoints exclusivos. Migrações históricas e tabelas antigas permanecem inertes para upgrades e recuperação. Tickets já existentes continuam operacionais. Nenhum dado histórico é descartado por esta remoção; um descarte exigirá decisão separada, backup e migração explícita. `/documentation` e seções antigas de configurações são apenas compatibilidade de navegação.

A remoção física futura exige backup, migração explícita e validação de que nenhuma instalação ainda depende desses registros. Compatibilidade de leitura não concede ao Hermes acesso a segredos antigos.

## Extensões

Investigações profundas, Git, Linear, AWS, bancos readonly, logs e conhecimento privado são extensões do ambiente do agente. A segurança deve existir nas próprias credenciais e tools — por exemplo, usuário PostgreSQL tecnicamente readonly — além das instruções do modelo.

O SQLite local continua sendo a fonte operacional, independentemente do agente escolhido.
