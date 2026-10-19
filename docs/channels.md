# Canais de coleta

Em **Configurações → Canais → Conectar novo canal**, crie uma conexão com nome livre. Cada conexão possui autenticação, mapeamento, cliente opcional e monitoramento próprios. Não é necessário cadastrar um fornecedor no código.

O recebimento aceita eventos HTTP/JSON enviados pelo sistema de origem ou por uma integração intermediária. Não consulta APIs periodicamente, não executa scripts de transformação e não implementa autenticação OAuth ou desafios de protocolo específicos de fornecedores. Protocolos diferentes devem ser adaptados pelo remetente ao contrato documentado abaixo.

O WhatsApp continua utilizando Baileys, sessão, QR code, histórico, mídia e identificação de aliases. Seus IDs, vínculos, monitoramento e cursores são preservados pela migração. As duas entradas compartilham conversas, mensagens, triagem e tickets. Não existe envio de respostas pelos canais de coleta.

## Configurar, testar e ativar

1. Informe nome, descrição e, opcionalmente, o cliente das novas conversas. Sem cliente, as conversas ficam com identificação pendente. O vínculo de uma conversa existente não é substituído silenciosamente.
2. Cole o corpo JSON de uma mensagem real. Se a origem envia outro formato, escolha nos seletores os caminhos encontrados no exemplo e confira os valores apresentados. Relacione os papéis do remetente com Cliente ou Equipe sem editar JSON de configuração. Um exemplo demonstrativo opcional permite conhecer o fluxo, mas não comprova conexão.
3. Escolha autenticação por token Bearer ou assinatura HMAC. Para assinatura, informe a chave do aplicativo remetente, o cabeçalho, o algoritmo, a codificação e o prefixo exigidos pela origem. Um token usado para consultar a API da origem não substitui a chave que assina seus webhooks.
4. Salve e valide a mensagem. A prévia normaliza os dados sem gravar mensagens, consumir eventos ou criar chamados. Confira conversa, autor, papel, texto e data; copie a URL e a credencial para configurar o remetente. Uma instalação local precisa de um endereço alcançável pela origem; o produto não abre portas ou cria túneis automaticamente.
5. Ative o canal e faça um envio pelo sistema de origem. Confira **Ver recebimentos** para confirmar que o endpoint aceitou e processou o evento. Prévia válida e entrega real são verificações diferentes. Uma configuração nova ou editada exige uma nova prévia válida antes da ativação.

Canais novos começam em rascunho. Pausar bloqueia novos recebimentos e suspende o processamento dos eventos ainda na fila, preservando o histórico. Retomar permite continuar a fila. Eventos já transformados em mensagens seguem as regras existentes da triagem.

## Formato padrão

Envie `POST /api/channels/{connectionId}/events`, com `Content-Type: application/json` e a autenticação daquela conexão.

```json
{
  "eventId": "event-123",
  "eventType": "message.created",
  "eventOccurredAt": "2026-10-15T12:00:00Z",
  "messageId": "message-456",
  "conversationId": "conversation-789",
  "conversationTitle": "Atendimento de exemplo",
  "authorId": "contact-1",
  "authorName": "Pessoa cliente",
  "authorRole": "customer",
  "body": "Preciso de ajuda com meu pedido.",
  "occurredAt": "2026-10-15T12:00:00Z"
}
```

Campos opcionais: `conversationTitle`, `threadId`, `replyToMessageId`, `externalUrl` e `attachments`. Anexos são referências `{id, name, mimeType, url}`; URLs devem usar HTTPS, sem credenciais. O Threadmark apresenta links para a origem e não baixa automaticamente arquivos remotos. O WhatsApp mantém seu armazenamento local de anexos e sua transcrição.

`authorId`, `authorName` e `authorRole` são obrigatórios na criação. `authorRole` aceita `customer` ou `support`; mensagens da equipe são contexto. Uma mensagem nova precisa de texto ou de pelo menos um anexo. IDs numéricos inteiros seguros são normalizados para string.

`eventType` aceita `message.created`, `message.updated` e `message.deleted`; a ausência equivale a `message.created`. `eventOccurredAt` representa a revisão do conteúdo e, quando ausente, usa `occurredAt`. Eventos devem possuir IDs estáveis. A data da mensagem original é preservada nas edições.

Edições usam texto e anexos como o novo retrato completo do conteúdo. Revisões antigas ou com a mesma data são ignoradas. Exclusões preservam mensagem, autoria, vínculos e auditoria, substituindo o conteúdo visível por um marcador. Uma edição posterior não ressuscita conteúdo excluído.

Eventos de atualização/exclusão recebidos antes da mensagem original ficam em falha com `channel_message_missing`. Depois de receber a original, o administrador pode reprocessá-los.

## Mapeamento

No formato mapeado, cada campo aponta para um caminho do JSON, como `data.message.id` ou `items.0.text`. Os campos `eventId`, `messageId`, `conversationId` e `occurredAt` precisam de caminhos configurados.

Também é possível configurar:

- Datas ISO 8601 com fuso, Unix em segundos ou Unix em milissegundos.
- Correspondência de papéis, por exemplo `{"visitor":"customer","agent":"support"}`.
- Correspondência de eventos, por exemplo `{"created":"message.created","edited":"message.updated"}`.
- Conversas de grupo/canal ou privadas.

Os nomes técnicos permanecem em inglês. Caminhos são declarativos, sem funções ou expressões executáveis. Campos desconhecidos não passam a compor o evento normalizado.

## Autenticação e limites

- **Bearer:** token aleatório exclusivo do canal, devolvido na criação ou rotação. O SQLite guarda apenas seu SHA-256. Rotacionar invalida o anterior.
- **HMAC:** configure uma chave com pelo menos 32 caracteres e `authentication: "hmac"`. Os parâmetros `signatureAlgorithm` (`sha256` ou `sha1`), `signatureHeader`, `signatureEncoding` (`hex` ou `base64`) e `signaturePrefix` seguem a documentação do remetente. A origem assina o corpo exato; o prefixo é comparado junto da assinatura, sem remover ou reinterpretar partes do cabeçalho. SHA256 é o padrão; SHA1 só deve ser escolhido quando exigido pelo protocolo da origem. A chave permanece no cofre criptografado local. Configurações anteriores com `hmac_sha256` continuam funcionando com SHA256.
- Credenciais de canal só autorizam seu endpoint de coleta. Não concedem sessão, leitura de conversas ou acesso à configuração.
- Limite de 256 KiB por evento, texto de 20 mil caracteres, até 20 referências a anexos e mil eventos novos por minuto por conexão. Reentregas conhecidas não consomem novas linhas.

O retorno `202` confirma gravação durável do evento, não a conclusão da triagem. A resposta contém `accepted`, `duplicate` e o identificador interno `eventId`. Payload inválido retorna `400`; credencial inválida, `401`; canal inativo, `409`; corpo excessivo, `413`; tipo de conteúdo inválido, `415`; limite de recebimento, `429`.

## Processamento e operação

O worker do runtime processa a fila persistida a cada segundo, com limite por lote. Aplicação do evento e confirmação de processamento ocorrem na mesma transação SQLite. Um reinício retoma eventos pendentes; uma falha transacional não deixa uma mensagem aplicada pela metade.

A identidade de conversa inclui conexão, identificador externo e thread. A identidade da mensagem inclui a conversa e seu ID externo. Identidades de autores são limitadas à conexão; nomes iguais não causam fusão entre canais. As associações com a equipe do WhatsApp não desativam os autores de suporte de outros canais.

Em **Ver recebimentos**, administradores podem inspecionar os 50 eventos mais recentes e reprocessar falhas. O reprocessamento usa o payload original e a configuração atual validada, mantendo a deduplicação das mensagens. Logs e listagens de recebimento não expõem o payload nem a credencial. O payload original fica no SQLite privado para auditoria e reprocessamento.

As conversas e o Kanban exibem a origem e oferecem filtro de canal. API e CLI existentes continuam operacionais; o filtro HTTP opcional é `connectionId`, com `whatsapp` reservado para a captura nativa.

## Operação pela CLI

Use `threadmark channels list|get|create|update|test|activate|pause`. Os comandos aceitam o ID exato ou o nome completo do canal. Nomes duplicados exigem o ID; não há escolha automática. `list` e `get` são consultas. Criação, edição, teste, ativação e pausa exigem `--apply --as <pessoa>`; o teste registra a prévia válida, mas não cria mensagens ou tickets. A API exige proprietário ou administrador nessas operações.

A família também funciona com `threadmark --remote NAME channels ...` por HTTPS ou SSH. A credencial remota deve pertencer a um proprietário ou administrador para alterar canais. Operadores continuam podendo consultar os canais e filtrar conversas e tickets.

Para criar um canal Bearer pela CLI, informe `bearerToken` no JSON privado. O token deve ter pelo menos 32 caracteres; gere um valor aleatório exclusivo, como 32 bytes em Base64url. A CLI não imprime o token recebido da API. Na interface, o fluxo de geração e exibição única permanece disponível. Em uma edição, omita `bearerToken` para preservar o atual; informar um novo valor substitui o anterior e exige novo teste e ativação. Para HMAC, use `config.authentication = "hmac"`, os parâmetros da assinatura e `signatureSecret` no arquivo privado de entrada.

Exemplo de criação de um arquivo privado com token aleatório, sem imprimir a credencial:

```sh
mkdir -m 700 -p .data
node --input-type=module <<'JS'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync(".data/channel.json", JSON.stringify({
  name: "Atendimento externo",
  description: "Mensagens recebidas pela API",
  config: { authentication: "bearer" },
  bearerToken: randomBytes(32).toString("base64url")
}, null, 2), { mode: 0o600, flag: "wx" });
JS

threadmark channels create --input .data/channel.json --apply --as "Pessoa Admin" --json
threadmark channels list --json
threadmark channels get "Atendimento externo" --json
threadmark channels test "Atendimento externo" --input sample-message.json --apply --as "Pessoa Admin" --json
threadmark channels activate "Atendimento externo" --apply --as "Pessoa Admin" --json
threadmark channels pause "Atendimento externo" --apply --as "Pessoa Admin" --json
```

`sample-message.json` contém um evento no formato padrão acima ou no formato mapeado configurado. `channels test` somente valida a prévia; não faz um envio ao webhook nem testa conectividade com o remetente. `activate` exige uma prévia válida da configuração atual; também retoma um canal pausado sem alterações. `update` recebe o mesmo JSON completo de configuração de `create`, volta a rascunho e exige um novo teste. Preserve o arquivo de configuração e configure o remetente com o token guardado nele; nunca envie credenciais em argumentos da CLI nem as versione.

Filtro de canal nas listagens, combinável com os demais filtros e a paginação:

```sh
threadmark conversations list --channel "Atendimento externo" --attention pending --json
threadmark tickets list --channel "Atendimento externo" --status triage --json
threadmark tickets list --channel whatsapp --json
threadmark conversations list --channel all --json
```

Sem `--channel`, ou com `--channel all`, a consulta inclui todos os canais. `whatsapp` e `all` são seletores reservados; para canais com esses nomes, use o ID. `threadmark capabilities --json` anuncia os comandos e o filtro. O token de coleta do canal continua restrito ao webhook e não autentica a CLI. A triagem e as operações de tickets usam os mesmos comandos existentes para qualquer origem.

## Rotas de configuração

As rotas abaixo exigem autenticação normal da instalação; alterações, prévias, rotação e inspeção de eventos exigem proprietário ou administrador.

| Método | Rota | Operação |
|---|---|---|
| GET | `/api/channels` | Listar conexões sem credenciais |
| POST | `/api/channels` | Criar em rascunho; devolver token Bearer uma vez |
| PATCH | `/api/channels/:id` | Editar; voltar a rascunho e exigir novo teste |
| POST | `/api/channels/:id/preview` | Testar o payload sem coletar mensagens |
| PATCH | `/api/channels/:id/status` | Alterar para `draft`, `active` ou `paused` |
| POST | `/api/channels/:id/rotate-token` | Rotacionar token Bearer |
| GET | `/api/channels/:id/events` | Inspecionar os recebimentos recentes |
| POST | `/api/channels/:id/events/:eventId/retry` | Recolocar uma falha na fila |

## Migração e recuperação

A migração 74 é executada pelo mecanismo existente de upgrade e backup pré-migração. Ela cria `conversations` como armazenamento neutro, preservando IDs e referências. `whatsapp_groups` permanece como visão de compatibilidade dos registros nativos; novos canais não criam contas WhatsApp nem JIDs fictícios.

Históricos externos importados são vinculados a mensagens canônicas, conservando IDs, conteúdo, autoria e tickets, sem duplicar contagens ou timeline. Na ausência de uma identidade confiável entre importações, a migração mantém conexões separadas, pausadas para revisão.

Configurações antigas específicas de fornecedores tornam-se HTTP genérico pausado, sem apagar referências aos segredos. Não são feitos testes remotos ou consultas a endpoints específicos durante a migração. Automações não relacionadas e a captura do WhatsApp continuam preservadas.

Antes de aplicar em uma instalação existente, valide um backup e ensaie o upgrade numa cópia isolada. Um retorno à versão anterior exige restaurar o snapshot compatível antes de iniciar o binário antigo, porque a nova estrutura de conversas altera referências do banco.
