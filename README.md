# Threadmark

Threadmark é uma central de suporte local-first que organiza conversas recebidas pelo WhatsApp em tickets e contexto operacional. Grupos e pessoas permanecem entidades nativas no Diretório. A captura é estritamente de entrada: o produto não possui composer, endpoint de envio nem automação de respostas no WhatsApp.

A persistência operacional de mensagens, anexos, configurações e investigações fica na máquina do operador. Quando um provedor remoto de IA é configurado, o recorte sanitizado necessário à tarefa é enviado a esse provedor. Uma sugestão de resposta só pode ser copiada e enviada manualmente pela equipe no aplicativo oficial.

> Threadmark usa o Baileys, um cliente não oficial e não afiliado ao WhatsApp ou à Meta. Avalie os termos aplicáveis e use apenas uma conta autorizada pela sua organização.

> A versão `0.2.x` continua em fase comunitária inicial e é validada de ponta a ponta somente no macOS. Faça backup antes de atualizar e não trate o conector não oficial como infraestrutura sem plano de contingência.

## Principais recursos

- Captura de histórico recuperado e novas mensagens de grupos, com deduplicação entre sincronizações e reconexões.
- Conversas completas no estilo WhatsApp, sem transformar automaticamente cada mensagem em ticket.
- Triagem supervisionada com janela de silêncio configurável, agrupamento semântico, espera por contexto e atualização de sugestões existentes.
- Seleção manual de mensagens para criar um ticket, anexar a um caso existente, guardar como contexto ou restaurar itens revisados.
- Diretório local com grupos e pessoas sincronizados do WhatsApp.
- Conversas, Kanban com contexto completo por card e arquivamento, Diretório, categorias e dashboard com período, responsável, comparação com o período anterior, eficiência operacional, envelhecimento do backlog e exportação filtrada.
- Automações visuais com gatilhos de ticket, condições, esperas, aprovações humanas, ações internas e apps conectados.
- Imagens exibidas no chat, suporte local a documentos e PDFs e transcrição opcional de áudios no próprio computador.
- Threadmark AI global em formato de chat, com histórico persistido, contexto da tela atual, evidências, sugestões de resposta e trabalho contínuo em segundo plano.
- Broker de ferramentas tipadas, disponível somente no Threadmark AI e limitado às fontes e ações autorizadas pelo workspace. Fontes técnicas permanecem readonly; escritas internas e externas usam operações explícitas e confirmação atual.
- SQLite como fonte de verdade e arquivos locais com permissões restritivas.

## Invariantes de segurança

- Nunca existe envio de mensagem pelo Threadmark.
- Mensagens da própria equipe são contexto e não abrem tickets.
- Casos ambíguos permanecem em revisão; não são descartados silenciosamente.
- Conteúdo de mensagens, anexos e documentos é tratado como não confiável pelo agente.
- A triagem não executa shell, código, banco ou infraestrutura.
- Ferramentas técnicas do Threadmark AI devem ser configuradas explicitamente e operar somente em leitura. A criação de ticket interno usa um rascunho persistido e uma confirmação posterior do operador.
- Credenciais, sessão do WhatsApp, banco, anexos, logs, backups e chaves ficam fora do Git.

Leia também a [política de segurança](SECURITY.md) e o guia de [privacidade e dados locais](docs/privacy.md).

## Arquitetura

```text
Baileys inbound-only
  -> normalização + deduplicação
  -> SQLite + anexos locais
  -> conversas permanentes
  -> blocos sugeridos para revisão humana
  -> ticket confirmado como recorte de mensagens
  -> contexto completo aberto pelo card do Kanban
  -> Threadmark AI global, opcional e persistente
  -> Web UI local
  -> cópia manual da resposta pelo operador
  -> resolução documentada no ticket
```

A Web UI é a interface operacional. A CLI permanece responsável pelo ciclo de vida e pelo diagnóstico, sem uma interface própria de terminal. Obsidian e outras pastas de conhecimento são integrações opcionais, nunca o banco bruto de mensagens. Veja [docs/architecture.md](docs/architecture.md) e a [ADR 0001](docs/decisions/0001-web-ui-and-obsidian.md).

## Automações e apps conectados

A área **Automações** oferece um editor visual baseado em nós. Um fluxo começa com um gatilho de ticket, pode aplicar condições, aguardar um período, exigir aprovação da equipe e então executar uma ação interna ou chamar um app conectado. Rascunhos incompletos podem ser salvos; a ativação só é permitida quando o grafo é válido, acíclico e sem junções ambíguas.

A disposição visual dos nós, o nome e a descrição são persistidos separadamente da definição funcional. Por isso, reorganizar o canvas ou editar esses metadados não desativa um fluxo ativo. Alterações em gatilhos, condições, conexões ou ações substituem a definição atual; um fluxo ativo permanece ativo e passa a usar a configuração nova nos próximos eventos, enquanto execuções já abertas preservam o snapshot com que começaram. O canvas exibe a configuração operacional principal de cada etapa, como `7 dias` ou `Arquivar ticket`.

As primeiras conexões disponíveis são Slack por webhook e API HTTP personalizada. Credenciais ficam no cofre local cifrado e nunca retornam para a interface. O botão de teste do fluxo executa apenas a validação estrutural e mostra o resultado no próprio canvas, sem persistir uma execução, alterar tickets ou chamar serviços externos. Execuções reais são persistidas no SQLite, retomam após reinício e permitem pausa, cancelamento e decisão humana nas etapas de aprovação.

Por segurança, o catálogo nunca oferece envio pelo WhatsApp. Automações também ignoram os eventos de ticket que elas próprias produziram, evitando ciclos involuntários. Na primeira inicialização do motor, o cursor começa no estado atual: eventos antigos não são reproduzidos em massa.

## Requisitos

- Node.js `>=22.13.0`.
- Uma conta do WhatsApp autorizada para o pareamento.
- Um provedor de IA configurado, caso deseje triagem e Threadmark AI.

O macOS é a única plataforma validada de ponta a ponta nesta versão. O serviço de inicialização automática usa LaunchAgent e é exclusivo do macOS. Linux e Windows ainda não são alvos oficialmente suportados; partes da aplicação podem funcionar, mas captura, notificações e ciclo de vida não possuem garantia ou matriz de testes nessas plataformas.

## Instalação local

```bash
git clone https://github.com/weslemvitor/threadmark.git
cd threadmark
install -m 600 .env.example .env
npm ci
npm run build
npm link
threadmark on
```

Esta versão é instalada a partir do código-fonte e não está publicada no registro npm. Não use `npm install -g threadmark`: o `npm link` acima registra o executável do clone atual. O tarball e a instalação global já são validados pela CI para uma publicação futura, mas nenhum pacote será enviado ao registro sem uma release explícita. Para atualizar ou remover a instalação, consulte [UPGRADE.md](UPGRADE.md).

Abra [http://127.0.0.1:3000](http://127.0.0.1:3000). Em uma instalação nova, o assistente inicial cria o administrador local e identifica o workspace. Depois, a área **Configurações** permite cadastrar a equipe, escolher o provedor de IA e parear o WhatsApp por QR Code. O login é local; não existe conta hospedada pelo projeto. Use esse endereço exato para que a sessão permaneça no mesmo host da API local.

As configurações básicas também podem ser preparadas em `.env`:

```dotenv
SUPPORT_API_HOST=127.0.0.1
SUPPORT_API_PORT=4317
SUPPORT_WEB_ORIGIN=http://127.0.0.1:3000
SUPPORT_DATA_DIR=.data
SUPPORT_WORKSPACE_NAME=Meu workspace
SUPPORT_WHATSAPP_NAME=Conta de suporte
SUPPORT_MONITORED_GROUPS=
SUPPORT_STAFF_IDENTITIES=
```

Não coloque tokens, senhas, pastas de código ou conexões técnicas no `.env.example`. Cadastre cada recurso em **Configurações → Ferramentas**; segredos são cifrados no cofre local e não entram no SQLite nem no Git. A interface mostra somente as ferramentas atualmente cadastradas. Instalações antigas que ainda possuem `SUPPORT_CODE_ROOTS` ou `SUPPORT_VAULT_DIR` podem migrá-las explicitamente pela CLI com `threadmark tools discover` e `threadmark tools recover`.

## Pareamento e grupos

1. Inicie o serviço com `threadmark on` (ou `npm run support:on` durante o desenvolvimento).
2. Escaneie o QR Code exibido na configuração ou no terminal.
3. Aguarde a descoberta dos grupos.
4. Escolha os grupos monitorados pela interface ou pelo comando `threadmark monitor <jid>`.
5. Cadastre os números, JIDs ou LIDs da equipe para que suas mensagens sejam apenas contexto.
6. Para medir uma possível revisão de mensagens já salvas, execute `threadmark rescan --days=30`. O comando mostra somente uma prévia: não altera mensagens, não reabre a fila e não chama a IA.

Com a lista de grupos monitorados vazia, o sistema opera em modo descoberta: salva o que for recebido, mas não abre candidatos de ticket para os grupos.

Mensagens privadas novas só entram na triagem quando o remetente está vinculado a pelo menos um grupo conhecido. Histórico privado antigo e contatos sem vínculo permanecem armazenados apenas como contexto.

## Diretório

O Diretório apresenta as identidades capturadas pelo WhatsApp:

- **grupos** exibem monitoramento, participantes, tickets e atividade recente;
- **pessoas** preservam nome, telefone, participação nos grupos e identificação da equipe;
- aliases de telefone e LID são consolidados para evitar participantes duplicados.

O Diretório não cria uma taxonomia comercial adicional. A organização operacional das demandas acontece nos tickets, categorias, responsáveis e prioridades.

## IA e Threadmark AI

O provedor/conexão e o modelo são escolhidos separadamente para cada tarefa em **Configurações → IA**: sugestões de ticket, Threadmark AI e geração de documentações. O Codex CLI integrado pode ser usado nas três; OpenAI, Anthropic, OpenRouter e Ollama também podem ser combinados por tarefa conforme a capacidade da conexão. O catálogo de modelos é carregado automaticamente, pode ser atualizado manualmente e sempre oferece uma opção para informar um identificador não listado. A barra fixa informa quando existem alterações não salvas e confirma o salvamento no SQLite. Cada sugestão, turno do assistente ou geração documental recebe um identificador e um estado persistido, evitando reprocessamento contínuo do mesmo conteúdo.

Nas sugestões de ticket, a janela de silêncio padrão é de três minutos e pode ser alterada na mesma tela. Cada nova mensagem externa reinicia a contagem; mensagens da equipe entram somente como contexto. A IA pode aguardar mais informações sem criar um card, atualizar uma sugestão pendente quando o assunto continua ou separar assuntos distintos. **Analisar agora** antecipa essa avaliação, mas não cria tickets automaticamente.

Ao resolver um ticket, a resolução é salva somente no atendimento. O encerramento não cria conteúdo reutilizável nem executa IA automaticamente. Quando o caso realmente contém um procedimento reaproveitável, o operador pode usar **Gerar documentação**. A IA cria um rascunho em português a partir das mensagens, da resolução e das imagens comprovadamente vinculadas ao ticket. O resultado fica persistido no SQLite em **Documentações**, exige revisão humana e pode ser copiado, exportado em DOCX compatível com importação no Intercom ou excluído definitivamente com confirmação; excluir a documentação não remove o ticket, as mensagens nem os anexos originais. O Threadmark não publica automaticamente no Intercom ou em outro serviço.

No Codex, sugestões e Threadmark AI rodam em uma execução efêmera sem rede livre, navegador, apps, plugins, MCP direto, memória ou HOME pessoal. A triagem recebe somente o contexto sanitizado e até cinco imagens preparadas. O assistente pode acessar apenas a codebase e as ferramentas locais explicitamente autorizadas, sempre em modo de leitura. Conexões MCP, quando configuradas, são executadas fora do modelo pelo broker local, que entrega somente ferramentas autorizadas e resultados limitados.

No Threadmark AI, qualquer modelo selecionado pode **solicitar** uma operação tipada. O Threadmark valida o ID e a operação contra **Configurações → Ferramentas** e **Apps conectados**, executa fora do processo do modelo e devolve apenas um resultado limitado e sanitizado no turno seguinte. Tokens e senhas nunca entram no prompt. Isso permite combinar Codex, OpenAI, Anthropic, OpenRouter ou Ollama com as mesmas autorizações locais, sem dar shell ao modelo. O conector nativo do Intercom recebe apenas a região e um access token protegido no cofre local; ele pode pesquisar e ler conversas, consultar o autor associado ao token, listar coleções e criar artigos somente em rascunho após confirmação explícita. Para transformar uma conversa em ticket, a IA precisa montar uma prévia associada a um grupo existente; somente uma nova mensagem confirmando explicitamente cria o ticket no SQLite, de forma idempotente e sem alterar o Intercom.

Proprietários e administradores também podem pedir ao Threadmark AI para criar ou editar automações. A IA consulta primeiro o catálogo e os IDs reais, persiste uma proposta e a apresenta sem alterar o fluxo atual. Uma mensagem posterior precisa confirmar a aplicação; fluxos novos continuam como rascunho. Ativar, pausar e excluir são confirmações separadas. O teste disponível nesse processo é um dry-run: valida nós, conexões, usuários e apps sem executar ações. Apps só podem entrar numa proposta quando estiverem ativos e explicitamente liberados para o Threadmark AI.

O botão **Testar conexão** faz uma leitura real, mínima e readonly no recurso configurado — inclusive PostgreSQL, ClickHouse, CloudWatch e Vercel — e persiste o último resultado. Uma configuração bem formada nunca é apresentada como conexão válida sem esse probe.

A triagem recebe apenas as mensagens candidatas, sugestões ainda abertas, anexos suportados e o contexto necessário da conversa. Ela pode separar assuntos, aguardar novas informações ou propor criar/anexar um ticket, mas não recebe precedentes resolvidos nem ferramentas técnicas. Áudios candidatos aguardam a transcrição local antes dessa avaliação.

O Threadmark AI fica disponível globalmente no canto da aplicação e recebe um retrato persistido da tela atual. Ao ser aberto a partir de um ticket, grupo ou conversa, o contexto correspondente acompanha a mensagem; referências explícitas como `#123` também carregam o ticket indicado. Fechar o painel, trocar de página ou reiniciar a interface não cancela o trabalho: o job continua no servidor e pode ser interrompido somente pelo botão **Parar**, por conclusão ou por um bloqueio real. No Codex CLI local os turnos não possuem um timeout artificial; uma interrupção do daemon devolve o job à fila para retomada segura. Falhas transitórias recebem até três tentativas persistidas. Se o bloqueio permanecer, ele aparece no próprio chat e o operador pode solicitar outra tentativa sem perder a mensagem ou a auditoria já coletada.

Além das ferramentas configuradas pelo operador, o assistente possui uma busca interna fixa, limitada e somente leitura no SQLite do próprio Threadmark. Ela localiza tickets, conversas, mensagens e resoluções por número, título, grupo, pessoa ou texto, sem permitir SQL arbitrário. Assim, uma pergunta global pode recuperar o atendimento correto mesmo quando o painel é aberto fora da tela daquele ticket.

Cada operação e resultado é salvo imediatamente numa auditoria append-only no SQLite, antes da próxima rodada do modelo. Uma evidência técnica só é aceita quando sua origem corresponde à ferramenta realmente executada — código, PostgreSQL, ClickHouse, AWS ou deployment — e à referência persistida dessa execução. Assim, uma falha posterior não apaga o que já foi consultado, uma retomada não repete a mesma execução e o modelo não pode reclassificar arbitrariamente uma fonte. Mensagens, resumos duráveis, evidências, próximas ações e respostas sugeridas também permanecem persistidos. O assistente pode preparar uma ação e seus parâmetros, mas nenhuma mutação é executada sem confirmação explícita e auditável; o WhatsApp continua sem qualquer capacidade outbound.

Ferramentas disponíveis nesta versão:

- pasta de código e pasta de conhecimento: listar, buscar e ler arquivos dentro da raiz autorizada;
- skill de depuração: leitura da metodologia, sem execução automática dos comandos descritos nela;
- PostgreSQL e ClickHouse: descrição de esquema e consulta `SELECT/WITH`, com timeout e limite de linhas;
- AWS CloudWatch: filtros de logs por prefixos autorizados e leitura de métricas;
- Vercel: deployments e runtime logs do projeto configurado.

Para PostgreSQL, use obrigatoriamente um usuário realmente readonly. O Threadmark inclui o cliente PostgreSQL no próprio pacote, portanto não exige a instalação do comando `psql`. O executor também aplica transação somente leitura, bloqueia instruções mutáveis e funções perigosas e limita a saída em streaming. No ClickHouse, table functions externas são recusadas. Esses controles não transformam uma credencial administrativa em uma credencial segura.

Para o runner local do Codex, instale e autentique o CLI e deixe `CODEX_BIN=codex`. A interface lê o catálogo exposto pela própria CLI e permite usar o padrão da conta ou um modelo específico em cada tarefa. Outros conectores podem exigir uma chave cadastrada localmente. Nunca versionar chaves.

“Codex local” significa que a CLI, a autenticação e a orquestração rodam na máquina. Ao usar modelos hospedados da OpenAI, o recorte sanitizado necessário à tarefa é enviado ao serviço da OpenAI; para inferência integralmente local, configure Ollama ou outro backend local compatível.

### Transcrição local de áudios

Em **Configurações → IA → Transcrição local de áudios**, escolha e baixe um dos modelos Whisper disponíveis. Essa função não usa Codex, Ollama nem uma API paga: o modelo é baixado uma vez e executado pelo próprio processo do Threadmark. A tela informa o espaço estimado em disco, o consumo estimado de RAM, o andamento do download e o estado da fila. O primeiro download exige acesso à internet; depois disso, a inferência funciona localmente.

A transcrição vem desativada em instalações novas. Depois de instalar o modelo, ative o processamento de novos áudios. O texto aparece junto ao player nas conversas e nos tickets; resultados incertos ficam marcados para revisão. O arquivo original é preservado, e o modelo é descarregado da memória após um período sem uso.

Áudios novos só alimentam a triagem depois que a transcrição termina. Para evitar custo inesperado e uma fila retroativa em massa, o histórico entra apenas por uma ação manual de até 100 áudios por vez. Transcrever histórico nunca reabre mensagens nem cria candidatos retroativos de ticket.

## Uso diário

```bash
threadmark on             # inicia API, Web UI, captura, triagem e worker
threadmark open           # abre a Web UI
threadmark status         # mostra o estado local
threadmark doctor         # verifica processo, API, Web, SQLite, WhatsApp, IA e disco
threadmark tools open     # cadastra pastas, bancos e observabilidade autorizados
threadmark tools list     # mostra as ferramentas locais sem revelar credenciais
threadmark tools discover # revisa fontes encontradas na configuração antiga
threadmark tools recover  # importa fontes antigas após confirmação explícita
threadmark tools test ID  # executa um probe real, limitado e readonly
threadmark off            # encerra os processos com segurança
```

`npm link` registra o executável local `threadmark` sem copiar dados ou configurações.
Use `threadmark configure` para escolher uma área de configuração, ou abra diretamente
`threadmark configure ai`, `threadmark configure tools`, `threadmark configure whatsapp`
e `threadmark configure team`.

No macOS, o serviço opcional inicia após o login e recupera falhas do processo:

```bash
threadmark service install
threadmark service status
threadmark service uninstall # preserva banco, anexos e configurações
```

O watchdog interno recupera somente a Web UI com backoff quando ela cai; API, captura e
workers continuam ativos. O arquivo `logs/daemon.log` dentro de `SUPPORT_DATA_DIR` é rotacionado de forma conservadora
ao atingir 5 MiB, mantendo cinco gerações.

`threadmark on` confirma a identidade da API antes de abrir ou migrar o SQLite e só anuncia sucesso após API e assets Web estarem prontos. `threadmark off` solicita shutdown pela API com o token desta instalação; ele nunca encerra um PID apenas porque apareceu num arquivo antigo. O Doctor testa somente os provedores usados pelos perfis ativos.

## Dados locais e backup

No fluxo de instalação acima, `.env.example` define `SUPPORT_DATA_DIR=.data`, então o estado privado fica no clone:

```text
.data/
  threadmark.sqlite
  threadmark.sqlite-wal
  threadmark.sqlite-shm
  attachments/
  backups/
  models/transcription/
  secrets/
  whatsapp-auth/
  logs/
  local-access.token
  runtime.json
  settings.json
```

Se `SUPPORT_DATA_DIR` não for definido, o runtime usa o diretório de dados do sistema operacional, como `~/Library/Application Support/Threadmark` no macOS. Confira sempre o caminho efetivo antes de copiar, restaurar ou apagar dados.

Crie um snapshot consistente em **Configurações → Dados → Criar backup** ou pelo terminal:

```bash
threadmark backup                  # rápido: SQLite + configurações
threadmark backup --full           # completo: SQLite + configurações + anexos
threadmark backups list            # lista e valida os backups
threadmark backup validate <id>    # valida manifesto, SHA-256 e SQLite
threadmark off
threadmark restore <id>            # exige confirmação e cria safety backup
```

A interface e o comando informam o diretório exato gerado. Use o backup rápido antes de alterações de configuração e o completo antes de limpezas ou periodicamente quando os anexos forem importantes. Antes de qualquer migração pendente, o Threadmark cria automaticamente um snapshot versionado do SQLite.

Cada backup possui manifesto v2, checksums SHA-256 e verificação de integridade. O restore só roda com daemon e SQLite parados, prepara os dados em staging, salva o estado atual em um backup de segurança e tenta rollback se algo falhar. A limpeza por retenção ocorre somente depois do commit e nunca remove o estado restaurado se falhar. A retenção padrão mantém 7 rápidos, 4 completos, 3 de segurança e 5 pré-migração.

Sessão do WhatsApp, chaves de IA, credenciais de ferramentas e o cache dos modelos de transcrição são deliberadamente excluídos dos backups; depois de restaurar em outra máquina, reconecte o WhatsApp, recadastre os segredos e baixe novamente o modelo desejado. Guarde backups em destino criptografado e nunca os envie em relatórios de bug.

## Ambiente de demonstração

O seed usa nomes, telefones e negócios fictícios e só aceita um diretório terminado em `/presentation`:

```bash
SUPPORT_DATA_DIR=.data/presentation \
SUPPORT_WHATSAPP_ENABLED=false \
SUPPORT_AGENT_ENABLED=true \
npm run demo:reset

SUPPORT_DATA_DIR=.data/presentation \
SUPPORT_WHATSAPP_ENABLED=false \
SUPPORT_AGENT_ENABLED=true \
npm run support:on
```

O reset preserva o estado anterior em `.data/presentation-backups/`. O cenário inclui grupos, pessoas, registros organizacionais, tickets resolvidos, um PDF e uma imagem; nenhuma investigação começa sozinha.

## Desenvolvimento e validação

```bash
npm run dev
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run audit:runtime
```

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar mudanças.

## Estrutura do repositório

- `app/`: interface web local.
- `server/whatsapp/`: fronteira Baileys inbound-only.
- `server/ingestion/`: normalização e persistência de mensagens e mídias.
- `server/db/`: schema e migrações SQLite.
- `server/domain/`: tickets, Diretório, categorias, documentações e auditoria.
- `server/triage/`: detecção conservadora de demandas.
- `server/agent/`: prompts, provedores e worker do Threadmark AI.
- `server/transcription/`: catálogo, download, execução e fila local de transcrição.
- `server/runtime/`: configuração, estado e settings locais.
- `shared/`: contratos compartilhados pela API e UI.
- `docs/`: arquitetura, privacidade e decisões técnicas.
- `.data/`: estado local privado, ignorado pelo Git.

## Limitações atuais

- A transcrição local aceita inicialmente os áudios OGG/Opus recebidos pelo WhatsApp; outros codecs podem permanecer apenas preservados.
- A central de notificações registra avisos internos por usuário no SQLite. Automações e investigações podem criar notificações com link para o contexto, sem depender de permissões, HTTPS ou serviços externos do navegador.
- Imagens e PDFs são os principais responsáveis pelo crescimento em disco.
- O Baileys não é uma API oficial; mudanças no WhatsApp podem exigir manutenção do conector.

Threadmark não é afiliado, patrocinado ou endossado pelo WhatsApp, Meta, OpenAI, Anthropic ou pelos provedores compatíveis.

## Documentação

- [Arquitetura e API principal](docs/architecture.md)
- [Diretório personalizável](docs/directory.md)
- [Privacidade e dados locais](docs/privacy.md)
- [Decisão sobre Web UI e Obsidian](docs/decisions/0001-web-ui-and-obsidian.md)
- [Decisão sobre organização por features](docs/decisions/0002-feature-first-architecture.md)
- [Atualização, rollback e desinstalação](UPGRADE.md)
- [Política de segurança](SECURITY.md)
- [Guia de contribuição](CONTRIBUTING.md)
- [Código de Conduta](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Contrato interno do conector WhatsApp](server/whatsapp/README.md)
- [Convenções para agentes de código](AGENTS.md)

## Licença

Threadmark é distribuído sob a [licença MIT](LICENSE). Copyright © 2026 Weslem Vitor.
