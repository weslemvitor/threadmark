# Arquitetura

Threadmark é uma aplicação local-first dividida em quatro superfícies: captura inbound do WhatsApp, domínio persistido em SQLite, agentes de IA configuráveis e interfaces locais.

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
       -> sala de investigação profunda iniciada manualmente
            -> provedor de IA configurado
            -> conhecimento permitido
            -> pedido JSON de operação tipada
            -> broker local valida autorização
            -> executor readonly devolve resultado limitado
  -> Web UI + OpenTUI
```

## Processos locais

- Web UI: `http://127.0.0.1:3000`.
- API: `http://127.0.0.1:4317` por padrão.
- Daemon: captura, heartbeat, triagem, transcrição local e worker da sala de investigação.
- OpenTUI: cliente da mesma API; sair da interface não encerra o daemon.

Todos os listeners usam loopback por padrão. Expor a API em outra interface muda o modelo de ameaça e exige proteção de rede adicional.

## Persistência

SQLite é a fonte de verdade para contas, participantes, grupos, mensagens, tickets, categorias, jobs, salas de investigação, auditoria e configuração operacional. Anexos são arquivos locais referenciados pelo banco.

Áudios OGG/Opus podem ser transcritos por um worker local opcional. Configuração, download dos modelos, progresso, tentativas e resultados ficam persistidos no SQLite; o cache do modelo fica dentro do diretório privado de dados. O áudio original não é substituído. Novos áudios só retornam à triagem depois de uma transcrição concluída, enquanto áudios históricos entram exclusivamente numa fila manual limitada e não reabrem a triagem.

Mensagens nunca são movidas para dentro de um ticket. `ticket_messages` registra um recorte explícito da conversa original, permitindo múltiplos assuntos no mesmo grupo sem duplicação nem perda de contexto.

O banco, WAL/SHM, anexos, autenticação do WhatsApp, segredos e logs ficam sob `SUPPORT_DATA_DIR` e não devem ser versionados.

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
- `archived`: ocultado das visões ativas sem apagar o histórico.

Mapeamento do Kanban: `new`/`triage` → Todo, `in_progress` → In Progress, `waiting_customer`/`blocked` → Blocked, `resolved` → Done. Arquivados aparecem em uma visão separada.

## Resolução

Resolver um ticket persiste apenas a resolução e o histórico operacional do atendimento. Esse fluxo não chama IA nem cria conteúdo reutilizável automaticamente.

## Agentes e confiança

A interface de agente separa o domínio dos provedores. O worker fornece prompts e schemas estruturados; cada adaptador traduz a requisição e valida a resposta antes de persistir o resultado.

O contexto de análise contém um estado explícito da conversa: última mensagem externa, última resposta capturada da equipe e IDs das mensagens externas posteriores a ela. Respostas enviadas são fatos imutáveis do atendimento, não modelos para uma nova sugestão. Ao capturar uma resposta manual em tempo real ou receber uma nova demanda externa, o domínio torna candidatas antigas obsoletas antes de persistir qualquer nova minuta. Uma resposta encontrada em histórico continua sendo armazenada, mas só invalida a candidata se for cronologicamente posterior a ela ou reproduzir exatamente seu texto; respostas históricas anteriores não disparam reanálises em massa. `already_answered` só é aceito quando existe uma resposta registrada, não há solicitação externa posterior e o modelo conclui que ela atendeu materialmente a demanda. Uma confirmação de recebimento ou promessa de investigação não impede uma resposta final nova.

O contexto explícito do Diretório e a conversa atual são as fontes primárias. Precedentes de tickets resolvidos são limitados ao mesmo registro atendido, exigem uma resolução validada e são ranqueados por compatibilidade e recência. O modelo só pode citá-los com o ID persistido em `resolved_ticket`; referências ausentes do recorte são rejeitadas na validação. Precedentes servem para orientar a investigação, nunca para repetir automaticamente uma resposta enviada anteriormente.

A triagem não recebe precedentes resolvidos, shell, banco, infraestrutura nem acesso irrestrito ao filesystem. O processo da sala profunda permanece isolado: não recebe credenciais nem acesso direto às ferramentas. Ele pode solicitar operações tipadas; o broker local confere ferramenta ativa, escopo profundo e operação permitida antes de executar.

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
- `POST /api/tickets/:id/investigation-thread`
- `GET /api/investigation-threads/:id`
- `POST /api/investigation-threads/:id/messages` e `POST /api/investigation-threads/:id/cancel`

A sala de investigação é iniciada somente pelo operador. Não existe rota nem fila executável de investigação automática do ticket.

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

Nenhuma rota de envio de mensagens deve existir.

## Extensões opcionais

- Pastas de Markdown/Obsidian como conhecimento curado.
- Raízes de código readonly para validar regras de negócio.
- Provedores de IA locais ou remotos.
- Ferramentas técnicas readonly com escopo explícito, credenciais cifradas fora do SQLite e operações habilitadas individualmente.

Integrações opcionais não alteram a propriedade dos dados: o SQLite local continua sendo a fonte operacional.
