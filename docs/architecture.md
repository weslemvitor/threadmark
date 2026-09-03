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

Threadmark Web/Desktop
  -> API local
  -> revisão visual, separação de assuntos e operação do suporte

Hermes / modelo / skills
  -> CLI threadmark
      -> API autenticada
          -> regras de domínio, permissões, auditoria e SQLite
  -> Git, Linear, AWS, bancos readonly e outras ferramentas do agente
```

## Processos locais

- Web UI: `http://127.0.0.1:3000`.
- API: `http://127.0.0.1:4317` por padrão.
- Daemon: captura, heartbeat, scheduler, transcrição local opcional e automações internas.
- CLI: fachada de domínio versionada para operação humana e agentes externos.
- Desktop: abre a Web UI em um renderer isolado e inicia ou reutiliza o daemon local.
- Executor de triagem: interno por compatibilidade ou externo com `SUPPORT_AGENT_EXECUTOR=hermes`.

Todos os listeners usam loopback por padrão. Expor a API em outra interface muda o modelo de ameaça e exige autenticação e proteção de rede próprias.

## Shell desktop e workspaces

O Electron contém apenas janela, ciclo de vida da interface e escolha do workspace. React, shadcn/ui e Tailwind permanecem no renderer. Ele opera com `nodeIntegration: false`, `contextIsolation: true`, sandbox habilitado, permissões negadas por padrão e navegação limitada à origem do workspace.

O perfil fica em `desktop-workspace.json`, fora do SQLite e com permissão privada:

1. `local`: inicia ou reutiliza `threadmark on` e acessa `127.0.0.1`;
2. `remote`: não inicia o daemon local e carrega uma origem HTTPS previamente configurada.

Trocar o perfil não move nem remove dados. A edição hospedada ainda exige uma implantação compatível, autenticação remota, TLS e migração controlada.

## Persistência

SQLite é a fonte de verdade para contas, participantes, grupos, mensagens, tickets, categorias, jobs, auditoria e configuração operacional. Anexos são arquivos locais referenciados pelo banco.

Mensagens nunca são copiadas para dentro de um ticket. `ticket_messages` registra um recorte explícito da conversa original, permitindo separar assuntos no mesmo grupo sem duplicação nem perda de contexto.

O banco, WAL/SHM, anexos, autenticação do WhatsApp, segredos e logs ficam sob `SUPPORT_DATA_DIR` e não entram no Git. Skills, memória, credenciais e integrações específicas da organização pertencem ao perfil privado do agente e também não entram no SQLite do Threadmark.

Áudios OGG/Opus podem ser transcritos por um worker local opcional. O arquivo original é preservado, e o cache do modelo local fica no diretório privado de dados.

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

Os endpoints privados de execução externa aceitam somente a identidade de agente esperada. Claim, heartbeat e conclusão de triagem são auditáveis e usam lease; um job abandonado pode ser recuperado sem concorrência entre o executor interno e o externo.

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

O código ainda preserva o executor interno, históricos de Threadmark AI, objetos de conhecimento, rascunhos de documentação e registros de ferramentas/apps para recuperação e migração sem perda de dados. Essas superfícies não aparecem na navegação nova e não são o caminho recomendado.

A remoção física futura exige backup, migração explícita e validação de que nenhuma instalação ainda depende desses registros. Compatibilidade de leitura não concede ao Hermes acesso a segredos antigos.

## Extensões

Investigações profundas, Git, Linear, AWS, bancos readonly, logs e conhecimento privado são extensões do ambiente do agente. A segurança deve existir nas próprias credenciais e tools — por exemplo, usuário PostgreSQL tecnicamente readonly — além das instruções do modelo.

O SQLite local continua sendo a fonte operacional, independentemente do agente escolhido.
