# Contrato HTTP esperado pelo editor de automações

O cliente provisório fica isolado em `data/automation-api.ts`. A interface não
armazena fluxos ou credenciais no navegador: SQLite continua sendo a fonte de
verdade.

## Fluxos

- `GET /api/automations` — `{ items: AutomationSummary[] }`
- `POST /api/automations` — cria um rascunho
- `GET /api/automations/:id` — retorna definição e metadados
- `PUT /api/automations/:id` — substitui a definição atual; aceita rascunhos incompletos para o autosave e mantém o fluxo ativo
- `PATCH /api/automations/:id/metadata` — salva somente nome e descrição, sem criar versão funcional ou alterar o status do fluxo
- `PATCH /api/automations/:id/layout` — salva somente as coordenadas do canvas, sem criar versão funcional ou alterar o status do fluxo
- `DELETE /api/automations/:id` — remove um rascunho permitido pelo domínio
- `POST /api/automations/:id/activate` — valida e ativa a versão salva
- `POST /api/automations/:id/pause` — impede novas execuções
- `POST /api/automations/:id/test` — valida o fluxo em memória sem executar ações nem criar histórico; retorna `dryRun: true` e as etapas detalhadas em `steps`
- `POST /api/automation-runs/:id/decision` — aprova ou rejeita a etapa humana atual
- `POST /api/automation-runs/:id/pause` — pausa uma execução retomável
- `POST /api/automation-runs/:id/resume` — retoma uma execução pausada
- `POST /api/automation-runs/:id/cancel` — encerra a execução sem executar novas etapas

A definição usa os tipos de runtime `trigger`, `condition`, `wait`, `approval`,
`internal_action` e `app_action`. O identificador específico fica em
`config.eventType`, `config.actionId` e `config.appId`, conforme o tipo.

O editor envia o rascunho ao SQLite após cada alteração funcional estabilizada.
Nós e conexões permanecem salvos mesmo antes de o fluxo ficar válido para
ativação. Posições são persistidas separadamente; reorganizar o canvas não cria
uma nova versão nem transforma um fluxo ativo em rascunho. Nome e descrição
também são metadados independentes: são salvos ao sair do campo ou pela ação
manual, sem desativar o fluxo. O Dry Run fica visível no canvas durante o teste,
mas não é persistido, não chama conectores e não altera tickets.

## Apps conectados

- `GET /api/automation-apps` — lista conexões sem devolver segredos
- `POST /api/automation-apps` — cria Slack webhook ou API personalizada
- `PATCH /api/automation-apps/:id` — atualiza configuração; segredo vazio mantém o atual
- `POST /api/automation-apps/:id/test` — testa sem revelar a credencial
- `DELETE /api/automation-apps/:id` — remove após validação de vínculos

`ConnectedAppSummary` devolve apenas `secretConfigured` e um
`endpointPreview` mascarado. Tokens, webhooks completos e headers secretos
nunca fazem parte de respostas HTTP, logs ou estado persistido do frontend.

O WhatsApp não é exposto como ação neste catálogo.

## Notificações internas

- `GET /api/notifications` — lista as notificações do operador atual
- `GET /api/notifications/unread-count` — informa o total não lido
- `PATCH /api/notifications/:id` — marca uma notificação como lida ou não lida
- `POST /api/notifications/read-all` — marca todas como lidas

O nó interno `create_in_app_notification` pode notificar o responsável pelo
ticket, toda a equipe ou um operador específico. Cada aviso é persistido por
usuário no SQLite com chave de idempotência. O Dry Run descreve os destinatários
e o conteúdo sem criar uma notificação real.
