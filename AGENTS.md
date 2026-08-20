# Threadmark

Aplicação local de suporte assistido para observar conversas recebidas pelo WhatsApp, transformar recortes confirmados em tickets e documentar resoluções.

## Regras inegociáveis

- O conector WhatsApp é estritamente de entrada. Nunca implementar ou expor `sendMessage`, composer, envio automático ou qualquer ação outbound.
- SQLite é a fonte de verdade operacional. Obsidian recebe apenas conhecimento curado e projeções aprovadas.
- Mensagens da equipe são armazenadas como contexto, mas nunca abrem tickets.
- Casos ambíguos entram em revisão; não descartar silenciosamente uma possível demanda.
- Sugestão, resposta realmente enviada e resolução validada são registros diferentes.
- Grupos e pessoas são entidades nativas. O Diretório deve permanecer agnóstico, com tipos, campos, registros e segmentos configuráveis pela instalação.
- Consultas a PostgreSQL, ClickHouse, AWS e outras ferramentas devem ser tecnicamente readonly, limitadas e auditadas.
- Credenciais, auth state do WhatsApp, banco local, logs e anexos nunca entram no Git.

## Convenções

- TypeScript estrito.
- Horários persistidos em UTC e exibidos no fuso IANA configurado para o workspace (`America/Sao_Paulo` por padrão).
- IDs externos do WhatsApp devem ser idempotentes e deduplicados.
- UI em português brasileiro.
- A Web UI é somente leitura para conversas; pode copiar sugestões e alterar o estado interno do ticket.
- Transcrição de áudio é opcional, local e deve preservar o arquivo original; a triagem espera transcrições realtime pendentes.
- Validar mudanças com testes focados, typecheck, lint e build.

## Estrutura

- `app/`: Web UI local.
- `server/`: API, SQLite, provedores de IA, daemon e captura Baileys.
- `shared/`: contratos compartilhados entre UI e servidor.
- `.data/`: estado local ignorado pelo Git.
- `tests/`: testes de comportamento.
- `docs/`: arquitetura, privacidade e decisões técnicas.
