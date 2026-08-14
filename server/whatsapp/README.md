# WhatsApp inbound

Este modulo e uma fronteira estritamente de entrada. A API publica oferece
somente `start`, `stop`, estado, normalizacao e binding de eventos. O socket do
Baileys nunca e devolvido ao chamador e `sendMessage` nao faz parte de nenhum
contrato exportado.

## Contrato do sink SQLite

O daemon injeta um `InboundMessageSink`:

1. `upsertMessages` deve executar um upsert transacional pela chave unica
   `idempotencyKey`. A mesma mensagem pode chegar pelo historico e novamente em
   tempo real.
2. Toda mensagem deve ser persistida. `eligibleForTicket = false` significa
   apenas que a mensagem nao entra automaticamente na fila operacional;
   mensagens da equipe, grupos fora da allowlist e historico continuam
   disponiveis como contexto. Em grupos e conversas diretas, somente
   `messages.upsert` do tipo `notify` e elegivel por origem. Historico inicial e
   `append` nunca criam tickets retroativos. Quando uma sincronizacao recupera
   mensagens realmente novas do periodo em que o servico ficou offline, o sink
   pode promove-las para revisao usando o cursor persistido da conversa. O
   cutoff e fotografado ao abrir a conexao ou iniciar a sessao de historico e
   permanece estavel entre chunks, inclusive quando chegam fora de ordem. Em
   conversa privada, a promocao exige vinculo ativo do contato com um grupo
   conhecido pela instalacao; o historico privado antigo continua apenas como contexto.
3. `hasMedia` permite evitar novo download em uma redelivery. `storeMedia`
   recebe bytes de imagem, documento ou áudio e metadados; deve gravar o arquivo de forma
   atomica fora do SQLite e salvar no banco caminho, hash, MIME e tamanho. O
   `idempotencyKey` do anexo tambem deve ter indice unico.
4. QR e efemero: `emitRuntimeEvent({ type: "qr" })` serve somente para exibir o
   pareamento atual e nunca deve ser persistido. Status, progresso e erros podem
   ser registrados sem o segredo do QR.

O downloader limita o tamanho declarado e o tamanho efetivamente recebido,
possui timeout e nunca impede a persistencia da mensagem quando uma midia
falha. Imagens e documentos entram no pipeline de analise; audio OGG/Opus pode
entrar na fila de transcricao local quando a funcao estiver ativa. Video e
sticker permanecem como metadados/contexto.

## Triagem supervisionada

O classificador registra apenas uma sugestao de criar, anexar ou ignorar. Ele
nao cria tickets, nao vincula mensagens e nao enfileira o Codex. Demandas e
casos incertos permanecem pendentes ate a confirmacao do operador. Conteudo
social isolado fica recolhido, auditavel e reversivel. Se uma demanda do mesmo
remetente chegar em ate dois minutos, a abertura social volta ao mesmo bloco de
contexto. O comando `rescan` apenas calcula uma previa do historico elegivel;
ele nao altera a fila, nao cria sugestoes e nao chama a IA.

Quando um audio candidato possui transcricao local pendente, a triagem espera o
worker terminar antes de montar o contexto. Audio historico enfileirado
manualmente nunca reabre a triagem nem cria candidato retroativo.

## Auth state

Baileys 7 ainda considera `useMultiFileAuthState` inadequado para servicos
remotos/multiprocesso. Threadmark e local, single-user e possui apenas um
processo de captura, entao o helper foi encapsulado em `auth.ts`. O diretorio e
forcado para modo `0700`, arquivos para `0600`, e links simbolicos sao
recusados. O caminho vem da configuracao do runtime e deve ficar dentro de
`SUPPORT_DATA_DIR`, que nao entra no Git.

Construir o client nao abre rede. A conexao com WhatsApp comeca somente quando
`start()` e chamado e permanece com reconexao exponencial ate `stop()` ou ate o
WhatsApp informar logout.
