# Arquitetura

Threadmark é uma aplicação local-first dividida em cinco superfícies: captura inbound do WhatsApp, domínio persistido em SQLite, agentes de IA configuráveis, Web UI e shell desktop.

```text
WhatsApp / Baileys (inbound-only)
  -> normalização, aliases e deduplicação
  -> SQLite + anexos no filesystem
       -> fila opcional de transcrição local de áudios
       -> conversas permanentes
       -> Diretório: grupos e pessoas
       -> triagem semântica idempotente
       -> revisão humana do bloco
       -> ticket como recorte explícito de mensagens
       -> contexto completo aberto pelo card do Kanban
       -> eventos de ticket para o motor persistente de automações
            -> condição / espera / aprovação
            -> ação interna auditável, notificação interna ou app conectado
       -> Threadmark AI global e persistente
            -> provedor de IA configurado
            -> contexto da tela e tickets referenciados
            -> conhecimento permitido
            -> pedido JSON de operação tipada
            -> broker local valida autorização
            -> executor readonly devolve resultado limitado
  -> Web UI
       -> navegador local
       -> shell Electron para macOS
```

## Processos locais

- Web UI: `http://127.0.0.1:3000`.
- API: `http://127.0.0.1:4317` por padrão.
- Daemon: captura, heartbeat, triagem, transcrição local e worker do Threadmark AI.
- CLI: controla ciclo de vida, configuração e diagnóstico sem duplicar a interface operacional.
- Desktop: abre a mesma Web UI em um renderer isolado e inicia ou reutiliza o daemon local.

Todos os listeners usam loopback por padrão. Expor a API em outra interface muda o modelo de ameaça e exige proteção de rede adicional.

## Shell desktop e workspaces

O Electron contém apenas a responsabilidade de janela, ciclo de vida da interface e escolha do workspace. React, shadcn/ui e Tailwind continuam no renderer existente. O renderer opera com `nodeIntegration: false`, `contextIsolation: true`, sandbox habilitado, permissões negadas por padrão e navegação limitada à origem do workspace. A ponte de preload expõe somente a URL da API, metadados não secretos e a operação validada de trocar o perfil da conexão.

O perfil do desktop fica em `desktop-workspace.json`, fora do SQLite e com permissão privada. A ausência ou corrupção desse arquivo sempre retorna ao modo local. Existem dois perfis:

1. `local`: inicia ou reutiliza `threadmark on` e acessa `127.0.0.1`;
2. `remote`: não inicia o daemon local e carrega uma origem HTTPS previamente configurada.

Trocar o perfil não move nem remove dados. O modo remoto pressupõe uma implantação compatível em que UI e API estejam atrás da mesma origem HTTPS. A distribuição de servidor, autenticação remota, provisionamento e migração controlada de dados são etapas posteriores; o shell não expõe SQLite nem portas internas diretamente à rede.

## Persistência

SQLite é a fonte de verdade para contas, participantes, grupos, mensagens, tickets, categorias, jobs, conversas do Threadmark AI, auditoria e configuração operacional. Anexos são arquivos locais referenciados pelo banco.

Áudios OGG/Opus podem ser transcritos por um worker local opcional. Configuração, download dos modelos, progresso, tentativas e resultados ficam persistidos no SQLite; o cache do modelo fica dentro do diretório privado de dados. O áudio original não é substituído. Novos áudios só retornam à triagem depois de uma transcrição concluída, enquanto áudios históricos entram exclusivamente numa fila manual limitada e não reabrem a triagem.

Mensagens nunca são movidas para dentro de um ticket. `ticket_messages` registra um recorte explícito da conversa original, permitindo múltiplos assuntos no mesmo grupo sem duplicação nem perda de contexto.

O banco, WAL/SHM, anexos, autenticação do WhatsApp, segredos e logs ficam sob `SUPPORT_DATA_DIR` e não devem ser versionados.

## Motor de automações

O motor usa uma definição funcional atual em forma de DAG e persiste fluxos, eventos, execuções e etapas no SQLite. Os nós disponíveis são `trigger`, `condition`, `wait`, `approval`, `internal_action` e `app_action`. Um fluxo ativo recebe somente eventos posteriores ao cursor durável da instalação; a primeira inicialização não reproduz todo o histórico de tickets. Execuções abertas preservam um snapshot da definição com que começaram, mas versões antigas concluídas não são mantidas como cópias permanentes do fluxo.

Waits, aprovações, tentativas e leases sobrevivem ao reinício do processo. Cada ação recebe uma chave de idempotência estável. Eventos derivados de ações internas carregam um ator próprio e não voltam ao motor, bloqueando loops autorreferentes. Junções e ciclos são recusados na ativação para manter a execução determinística.

Ações internas passam por handlers tipados do domínio de suporte. Apps conectados são resolvidos pelo registro de integrações e pelo cofre local. Slack webhook e HTTP personalizado usam timeout, limite de resposta, templates JSON controlados e proteção contra SSRF; hosts locais ou reservados são bloqueados por padrão. Não existe conector de ação outbound para WhatsApp.

A central de notificações é uma ação interna: avisos são persistidos por usuário no SQLite, com origem, destino interno, estado lido/não lido e chave idempotente por etapa da automação. A interface consulta esse histórico e pode abrir diretamente o contexto associado. Nenhum conteúdo passa por serviços de push ou depende de permissões do navegador.

## Diretório

O Diretório apresenta duas entidades nativas sincronizadas do WhatsApp:

1. **Grupos:** preservam JID, participantes, monitoramento, atividade e tickets relacionados.
2. **Pessoas:** preservam autoria, telefone, aliases PN/LID, participação em grupos e identificação da equipe.

A API `/api/directory` é somente leitura e retorna essas entidades com seus totais. Categorias, prioridade e responsável organizam os tickets sem alterar as mensagens originais.

## Fronteira inbound-only

O conector aceita sincronização de histórico, novas mensagens, anexos, reações, respostas citadas, alterações de roster e metadados necessários. Não existe método de envio, composer ou rota outbound.

Mensagens da equipe são persistidas como contexto. Apenas participantes externos podem originar candidatos, e uma sugestão nunca cria um ticket sem confirmação humana.

## Estados de triagem

Mensagens ficam em `unreviewed`, `ticketed`, `ignored` ou `context`. O classificador pode agrupar mensagens e sugerir `create`, `attach` ou `ignore`, mas a decisão final permanece com o operador.

Uma mensagem externa nova inicia uma janela de silêncio configurável, com padrão de 180 segundos. Outras mensagens externas reiniciam essa janela; mensagens da equipe continuam disponíveis como contexto, mas não adiam a análise. Ao fim da janela, a IA recebe o lote ainda pendente e as sugestões abertas da conversa. Ela pode criar uma sugestão, anexar o complemento à mesma sugestão, separar tópicos realmente distintos, ignorar o lote ou retornar `wait` quando ainda falta contexto.

`wait` não cria card e fica persistido em `triage_context_waits`. O mesmo conteúdo não é reprocessado até chegar outra mensagem externa ou o operador usar **Analisar agora**. Uma análise antecipada apenas enfileira a IA: ela nunca confirma nem cria o ticket. Se uma mensagem externa chegar durante um job, os vínculos daquele resultado são invalidados e a conversa volta a aguardar silêncio, impedindo que um resultado obsoleto altere os cards.

Cada job, vínculo com mensagem, espera e sugestão é persistido no SQLite. Isso garante idempotência, permite retomar após reinício e impede loops de custo ao recarregar a interface.

## Estados do ticket

- `new`: novo recorte confirmado.
- `triage`: em revisão.
- `in_progress`: investigação ou resposta em preparação.
- `waiting_customer`: aguardando o solicitante.
- `blocked`: aguardando dependência interna.
- `resolved`: resolvido manualmente.
- `cancelled`: encerrado sem resolução e sem exigir um resumo de solução.
- `archived`: ocultado das visões ativas sem apagar o histórico.

Mapeamento do Kanban: `new`/`triage` → A revisar, `in_progress` → Em andamento, `waiting_customer`/`blocked` → Aguardando, `resolved` → Resolvidos e `cancelled` → Cancelados. Resolvidos e cancelados podem ser arquivados; ao restaurar, o histórico devolve cada ticket ao estado terminal anterior.

## Resolução

Resolver um ticket persiste apenas a resolução e o histórico operacional do atendimento. Esse fluxo não chama IA nem cria conteúdo reutilizável automaticamente. Uma ação manual posterior inicia duas fases persistentes: `extraction` e `document`. Na primeira, o worker usa o perfil `documentation` para produzir um `knowledge_object` validado por schema. O objeto separa fatos, evidências, inferências e hipóteses; mantém confiança, classificação, público, lacunas, fontes e possíveis duplicidades. O backend rejeita fontes externas ao contexto, procedimento sem evidência operacional e conteúdo operacional de baixa confiança.

Na segunda fase, um renderizador determinístico cria o rascunho conforme tipo e público. Ele não pede à IA que reescreva livremente o ticket, não transforma hipótese em instrução e bloqueia detalhes internos em conteúdo para cliente ou suporte. `knowledge_objects` é a fonte de verdade; `knowledge_object_versions` preserva revisões humanas e `knowledge_review_feedback` registra aprovação, rejeição e motivos. `documentation_drafts` continua sendo a projeção editável/exportável para compatibilidade. A fila `documentation_generation_jobs` permanece recuperável após reinício e diferencia as duas fases. Não existe publicação automática em serviços externos.

## Agentes e confiança

A interface de agente separa o domínio dos provedores. O worker fornece prompts e schemas estruturados; cada adaptador traduz a requisição e valida a resposta antes de persistir o resultado. Casos representativos de documentação, privacidade e injeção de prompt integram `npm run eval:prompts` para comparação de qualidade entre versões e modelos.

O contexto de análise contém um estado explícito da conversa: última mensagem externa, última resposta capturada da equipe e IDs das mensagens externas posteriores a ela. Respostas enviadas são fatos imutáveis do atendimento, não modelos para uma nova sugestão. Ao capturar uma resposta manual em tempo real ou receber uma nova demanda externa, o domínio torna candidatas antigas obsoletas antes de persistir qualquer nova minuta. Uma resposta encontrada em histórico continua sendo armazenada, mas só invalida a candidata se for cronologicamente posterior a ela ou reproduzir exatamente seu texto; respostas históricas anteriores não disparam reanálises em massa. `already_answered` só é aceito quando existe uma resposta registrada, não há solicitação externa posterior e o modelo conclui que ela atendeu materialmente a demanda. Uma confirmação de recebimento ou promessa de investigação não impede uma resposta final nova.

O contexto explícito do Diretório e a conversa atual são as fontes primárias. Precedentes de tickets resolvidos são limitados ao mesmo registro atendido, exigem uma resolução validada e são ranqueados por compatibilidade e recência. O modelo só pode citá-los com o ID persistido em `resolved_ticket`; referências ausentes do recorte são rejeitadas na validação. Precedentes servem para orientar a investigação, nunca para repetir automaticamente uma resposta enviada anteriormente.

A triagem não recebe precedentes resolvidos, shell, banco, infraestrutura nem acesso irrestrito ao filesystem. O processo do Threadmark AI permanece isolado: não recebe credenciais nem acesso direto às ferramentas. Ele pode solicitar operações tipadas; o broker local confere ferramenta ativa, escopo profundo e operação permitida antes de executar. A ferramenta interna `threadmark-context` oferece pesquisa preparada e limitada sobre tickets, conversas, mensagens e resoluções do SQLite, sem aceitar SQL fornecido pelo modelo. Sua única escrita operacional é a criação confirmada de ticket: primeiro persiste uma prévia ligada à conversa do Threadmark AI; somente uma mensagem posterior e explicitamente afirmativa pode converter esse rascunho em ticket. A associação exige um grupo existente, é idempotente e preserva a origem externa no SQLite.

A ferramenta interna `threadmark-automations` segue a mesma fronteira. Leituras carregam o catálogo real, usuários ativos, apps autorizados e definições atuais. Criação e edição sempre geram primeiro uma proposta completa, validada e persistida separadamente; somente uma mensagem posterior do proprietário ou administrador pode aplicá-la. Uma criação nasce em rascunho. Ativar, pausar e excluir exigem pedidos explícitos separados, vinculados à mensagem atual. O dry-run valida o grafo e os apps sem criar execução nem disparar ação. A identidade do autor fica associada à mensagem para que o worker em segundo plano preserve as permissões originais, e cada operação continua registrada na auditoria append-only das ferramentas.

Apps Intercom autorizados usam um conector nativo, sem exigir que o operador monte URLs de endpoint. O cadastro solicita a região do workspace e o access token, que fica no cofre local e nunca entra no prompt ou no SQLite. O teste da conexão verifica, sem mutação, o acesso a conversas, ao autor associado ao token e às coleções. O Threadmark AI pode pesquisar e ler conversas, consultar o autor válido para `author_id`, listar coleções do Help Center e criar artigos estritamente em `draft` após confirmação explícita da mensagem atual. Endpoints de resposta, atribuição ou fechamento de conversa não são expostos. A criação de ticket continua sendo uma ação interna do Threadmark; o Intercom serve apenas como fonte readonly nesse fluxo.

Apps com servidor MCP remoto podem ser conectados por Streamable HTTP. O broker local faz a negociação do protocolo e descobre as ferramentas com `tools/list`; endpoint e catálogo sanitizado ficam no SQLite, enquanto o bearer token permanece no cofre local. A descoberta não concede acesso: cada ferramenta nasce bloqueada e precisa ser autorizada separadamente para Threadmark AI e para automações. O JSON Schema publicado pelo servidor gera os campos do nó no editor, mas nomes, descrições e anotações MCP são tratados como conteúdo não confiável. A autorização definida pelo proprietário é a fonte de verdade. Chamadas usam `tools/call`, timeout, limite de saída, bloqueio de redirecionamento e proteção contra SSRF; rede local é uma permissão explícita. Ferramentas marcadas para confirmação exigem um pedido atual no chat ou uma etapa de aprovação anterior no fluxo. Nesta versão, o transporte remoto aceita ausência de autenticação ou bearer token; OAuth MCP e servidores `stdio` não são iniciados automaticamente.

O executor resolve caminhos reais dentro da raiz autorizada, recusa arquivos de ambiente, credenciais, sessões e chaves, limita arquivos e saída, bloqueia SQL mutável e funções com efeitos externos, aplica timeout/linhas e usa drivers, APIs ou CLIs com parâmetros controlados. No PostgreSQL, um driver embutido executa a consulta em transação somente leitura e limita a resposta durante o streaming. Resultados de arquivos, consultas e logs continuam sendo evidência não confiável e retornam ao modelo dentro de delimitadores próprios.

Cada resultado de ferramenta entra imediatamente em `investigation_thread_tool_executions`, uma auditoria append-only por job e request. O coordenador só aceita evidência técnica quando a referência corresponde exatamente a uma execução bem-sucedida e a origem declarada combina com o tipo da ferramenta: código, PostgreSQL, ClickHouse, AWS ou deployment. A tabela, e não a resposta final do modelo, é a fonte de verdade para a timeline.

Mensagens, nomes, PDFs, imagens e textos extraídos são conteúdo não confiável. Eles aparecem dentro de delimitadores explícitos e nunca substituem as instruções de segurança do sistema.

## API principal

A lista abaixo resume as superfícies operacionais; consulte `shared/contracts.ts` para os payloads atuais. Rotas autenticadas exigem a sessão local apropriada.

### Runtime e configuração

- `GET /health`
- `GET /api/runtime/identity` e `POST /api/runtime/shutdown` (token local da instalação)
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
- `PATCH /api/tickets/:id/status` e `PATCH /api/tickets/:id/context`
- `GET /api/threadmark-ai/threads` e `POST /api/threadmark-ai/threads`
- `POST /api/threadmark-ai/current`
- `GET /api/threadmark-ai/threads/:id`
- `POST /api/threadmark-ai/threads/:id/messages` e `POST /api/threadmark-ai/threads/:id/cancel`

O Threadmark AI é iniciado somente pelo operador. Não existe rota nem fila executável de investigação automática do ticket. Turnos executados pelo Codex CLI local não recebem timeout de duração: continuam até conclusão, bloqueio real ou cancelamento explícito; encerramentos do daemon liberam o lease para retomada. Falhas transitórias são reenfileiradas até três tentativas e um bloqueio persistente fica visível no chat, com retomada manual sobre o mesmo turno. Rotas antigas de sala por ticket permanecem apenas para compatibilidade dos históricos migrados; a Web UI não as expõe.

### Diretório

- `GET /api/directory`
- `POST /api/directory/types` e `PUT /api/directory/types/:id`
- `POST /api/directory/fields` e `PUT /api/directory/fields/:id`
- `POST /api/directory/records`, `PUT /api/directory/records/:id` e `DELETE /api/directory/records/:id`
- `POST /api/directory/segments`, `PUT /api/directory/segments/:id` e `DELETE /api/directory/segments/:id`

### IA e ferramentas

- `GET /api/triage/settings` e `PUT /api/triage/settings`
- `GET /api/ai/connections` e `GET /api/ai/task-profiles`
- `GET /api/ai/audio-transcription` e `PUT /api/ai/audio-transcription`
- `POST /api/ai/audio-transcription/models/:id/install` e `DELETE /api/ai/audio-transcription/models/:id`
- `POST /api/ai/audio-transcription/history`, `POST /api/attachments/:id/transcription` e `POST /api/attachments/:id/transcription/retry`
- `GET /api/tools`, `POST /api/tools`, `PATCH /api/tools/:id` e `DELETE /api/tools/:id`
- `POST /api/tools/:id/test`
- `GET /api/dashboard` e `GET /api/dashboard/export`

As duas rotas do dashboard aceitam `from` e `to` como período inclusivo e `assigneeId` como filtro opcional. O valor reservado `unassigned` representa tickets sem responsável; a visão principal e o CSV usam o mesmo recorte, enquanto o comparativo da equipe permanece completo dentro do período selecionado. Quando há período, a resposta também calcula uma janela anterior de mesma duração e compara criação, resolução, backlog ao fim do recorte, taxa de resolução, tempo mediano do ciclo, reaberturas e tickets sem responsável. O envelhecimento reconstrói o estado dos tickets no fim do período usando o histórico persistido de eventos; a visão de todo o histórico não fabrica uma janela anterior.

### Automações e apps conectados

- `GET /api/automations`, `POST /api/automations` e `GET /api/automations/:id`
- `PUT /api/automations/:id`, `PATCH /api/automations/:id/metadata`, `PATCH /api/automations/:id/layout`, `DELETE /api/automations/:id`, `POST /api/automations/:id/activate`, `POST /api/automations/:id/pause` e `POST /api/automations/:id/test`
- `POST /api/automation-runs/:id/decision`, `POST /api/automation-runs/:id/pause`, `POST /api/automation-runs/:id/resume` e `POST /api/automation-runs/:id/cancel`
- `GET /api/automation-apps`, `POST /api/automation-apps`, `PATCH /api/automation-apps/:id`, `POST /api/automation-apps/:id/test` e `DELETE /api/automation-apps/:id`
- `GET /api/notifications`, `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id` e `POST /api/notifications/read-all`

Configuração e ativação exigem perfil de proprietário ou administrador. Operadores autenticados podem decidir aprovações e controlar execuções. Respostas de apps conectados expõem somente a existência do segredo e uma prévia mascarada do endpoint.

`automation_workflow_versions` mantém somente a definição funcional atual. Coordenadas do editor ficam em `automation_workflow_layouts`, permitindo reorganizar um fluxo ativo sem alterar seu status ou sua lógica. Nome e descrição são atualizados diretamente como metadados do workflow. Ao mudar a lógica, a definição atual é substituída; execuções abertas retêm seu próprio snapshot até terminarem, e os próximos eventos usam a configuração nova. O Dry Run é calculado em memória e mostrado no canvas sem criar uma execução persistida.

Nenhuma rota de envio de mensagens deve existir.

## Extensões opcionais

- Pastas de Markdown/Obsidian como conhecimento curado.
- Raízes de código readonly para validar regras de negócio.
- Provedores de IA locais ou remotos.
- Ferramentas técnicas readonly com escopo explícito, credenciais cifradas fora do SQLite e operações habilitadas individualmente.

Integrações opcionais não alteram a propriedade dos dados: o SQLite local continua sendo a fonte operacional.
