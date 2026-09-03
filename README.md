# Threadmark

Threadmark é uma central de suporte local-first que organiza conversas recebidas pelo WhatsApp em tickets e contexto operacional. Grupos e pessoas permanecem entidades nativas no Diretório. A captura é estritamente de entrada: o produto não possui composer, endpoint de envio nem automação de respostas no WhatsApp.

O backend também oferece uma CLI headless versionada para agentes externos. Nessa arquitetura, o Threadmark continua sendo a fonte de verdade e a interface de organização do suporte; Hermes, Codex ou outro agente podem investigar com suas próprias skills e operar tickets pela CLI, sem receber acesso direto ao SQLite ou ao token da API.

A persistência operacional de mensagens, anexos e tickets fica na máquina do operador. Modelos, skills, memória e ferramentas externas são configurados no agente escolhido, fora do Threadmark. Uma sugestão de resposta só pode ser enviada manualmente pela equipe no aplicativo oficial.

## Baixar o aplicativo

> [!IMPORTANT]
> **[Baixar o Threadmark 0.3.1 para macOS (Apple Silicon)](https://github.com/weslemvitor/threadmark/releases/download/v0.3.1/Threadmark-0.3.1-arm64.dmg)**
>
> Developer Preview para Macs com chips Apple M1, M2, M3, M4 ou posteriores. Macs Intel ainda não são suportados.

Baixe também o **[arquivo de verificação SHA-256](https://github.com/weslemvitor/threadmark/releases/download/v0.3.1/Threadmark-0.3.1-arm64.dmg.sha256)** e mantenha os dois arquivos na mesma pasta. No Terminal, abra essa pasta e valide o instalador:

```bash
shasum -a 256 -c Threadmark-0.3.1-arm64.dmg.sha256
```

O resultado deve terminar em `OK`. Depois:

1. Abra `Threadmark-0.3.1-arm64.dmg`.
2. Arraste `Threadmark.app` para **Aplicativos**.
3. Confirme que o DMG veio desta release oficial e passou na verificação acima.
4. Como esta Developer Preview ainda não é assinada nem notarizada pela Apple, execute:

```bash
xattr -dr com.apple.quarantine "/Applications/Threadmark.app"
open -a Threadmark
```

O comando `xattr` reduz uma proteção do macOS. Use-o somente depois de validar um instalador baixado da release oficial, nunca em uma cópia recebida por terceiros. Para consultar os arquivos publicados, notas da versão e checksum, abra a **[release v0.3.1](https://github.com/weslemvitor/threadmark/releases/tag/v0.3.1)**.

Na primeira abertura, o assistente cria o administrador e o workspace locais. Em seguida, use **Configurações** para cadastrar a equipe e parear o WhatsApp por QR Code. Seus dados ficam em `~/Library/Application Support/Threadmark`, fora do aplicativo, e permanecem no Mac ao atualizar o `.app`. Consulte [UPGRADE.md](UPGRADE.md) antes de atualizar, restaurar ou desinstalar.

Se você quer contribuir ou executar a versão mais recente diretamente do repositório, siga [Executar pelo código-fonte](#executar-pelo-código-fonte).

> Threadmark usa o Baileys, um cliente não oficial e não afiliado ao WhatsApp ou à Meta. Avalie os termos aplicáveis e use apenas uma conta autorizada pela sua organização.

> A versão `0.3.1` continua em fase de Developer Preview e é validada de ponta a ponta somente no macOS com Apple Silicon. Faça backup antes de atualizar e não trate o conector não oficial como infraestrutura sem plano de contingência.

## Principais recursos

- Captura de histórico recuperado e novas mensagens de grupos, com deduplicação entre sincronizações e reconexões.
- Conversas completas no estilo WhatsApp, sem transformar automaticamente cada mensagem em ticket.
- Triagem supervisionada com janela de silêncio configurável, agrupamento semântico, espera por contexto e atualização de sugestões existentes.
- Seleção manual de mensagens para criar um ticket, anexar a um caso existente, guardar como contexto ou restaurar itens revisados.
- Diretório local com grupos e pessoas sincronizados do WhatsApp.
- Conversas, Kanban com contexto completo por card e arquivamento, Diretório, categorias e dashboard com período, responsável, comparação com o período anterior, eficiência operacional, envelhecimento do backlog e exportação filtrada.
- Automações visuais internas com gatilhos de ticket, condições, esperas, aprovações humanas e ações do próprio Threadmark.
- Imagens exibidas no chat, suporte local a documentos e PDFs e transcrição opcional de áudios no próprio computador.
- CLI headless versionada para Hermes, Codex ou outro agente consultar conversas e operar tickets com contratos estáveis.
- Triagem assíncrona delegável ao agente externo, com claim atômico, lease, schema validado e sugestões sempre revisáveis na interface.
- SQLite como fonte de verdade e arquivos locais com permissões restritivas.

## Invariantes de segurança

- Nunca existe envio de mensagem pelo Threadmark.
- Mensagens da própria equipe são contexto e não abrem tickets.
- Casos ambíguos permanecem em revisão; não são descartados silenciosamente.
- Conteúdo de mensagens, anexos e documentos é tratado como não confiável pelo agente.
- A triagem não executa shell, código, banco ou infraestrutura.
- Ferramentas técnicas pertencem ao ambiente do agente e devem aplicar readonly na própria credencial ou tool. Escritas no Threadmark passam somente pela CLI, exigem `--apply`, identidade ativa e validação do domínio.
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
  -> Web UI local para revisão e organização
  -> CLI headless para o Hermes
      -> skills, modelos e ferramentas externas do agente
  -> cópia manual da resposta pelo operador
  -> resolução documentada no ticket
```

A mesma Web UI é a interface operacional no navegador e no aplicativo desktop. A CLI também expõe contratos de domínio para agentes externos, sem substituir a revisão visual. Obsidian e outras pastas de conhecimento são integrações opcionais, nunca o banco bruto de mensagens. Veja [docs/architecture.md](docs/architecture.md), a [ADR 0001](docs/decisions/0001-web-ui-and-obsidian.md), a [ADR 0003](docs/decisions/0003-desktop-local-and-remote-workspaces.md) e a [ADR 0004](docs/decisions/0004-headless-agent-cli.md).

## Automações internas

A área **Automações** oferece um editor visual baseado em nós. Um fluxo começa com um gatilho de ticket, pode aplicar condições, aguardar um período, exigir aprovação da equipe e então executar uma ação interna. Rascunhos incompletos podem ser salvos; a ativação só é permitida quando o grafo é válido, acíclico e sem junções ambíguas.

A disposição visual dos nós, o nome e a descrição são persistidos separadamente da definição funcional. Por isso, reorganizar o canvas ou editar esses metadados não desativa um fluxo ativo. Alterações em gatilhos, condições, conexões ou ações substituem a definição atual; um fluxo ativo permanece ativo e passa a usar a configuração nova nos próximos eventos, enquanto execuções já abertas preservam o snapshot com que começaram. O canvas exibe a configuração operacional principal de cada etapa, como `7 dias` ou `Arquivar ticket`.

O botão de teste do fluxo executa apenas a validação estrutural e mostra o resultado no próprio canvas, sem persistir uma execução nem alterar tickets. Execuções reais são persistidas no SQLite, retomam após reinício e permitem pausa, cancelamento e decisão humana nas etapas de aprovação. Integrações externas como GitHub, Linear, AWS e bancos pertencem ao ambiente do Hermes; conexões antigas permanecem preservadas apenas para que fluxos já existentes não sejam corrompidos durante a migração.

Por segurança, o catálogo nunca oferece envio pelo WhatsApp. Automações também ignoram os eventos de ticket que elas próprias produziram, evitando ciclos involuntários. Na primeira inicialização do motor, o cursor começa no estado atual: eventos antigos não são reproduzidos em massa.

## Executar pelo código-fonte

Este caminho é destinado a desenvolvimento, contribuição ou diagnóstico. Para apenas usar o Threadmark no Mac, prefira o [download do aplicativo](#baixar-o-aplicativo).

### Requisitos de desenvolvimento

- Node.js `>=22.13.0`.
- Uma conta do WhatsApp autorizada para o pareamento.
- Um agente externo configurado, caso deseje triagem semântica e investigação pelo terminal.

O macOS é a única plataforma validada de ponta a ponta nesta versão. O serviço de inicialização automática usa LaunchAgent e é exclusivo do macOS. Linux e Windows ainda não são alvos oficialmente suportados; partes da aplicação podem funcionar, mas captura, notificações e ciclo de vida não possuem garantia ou matriz de testes nessas plataformas.

### Instalação a partir do repositório

```bash
git clone https://github.com/weslemvitor/threadmark.git
cd threadmark
install -m 600 .env.example .env
npm ci
npm run build
npm link
threadmark on
```

O pacote não está publicado no registro npm. Não use `npm install -g threadmark`: o `npm link` acima registra o executável do clone atual. O tarball e a instalação global são validados pela CI para uma publicação futura, mas nenhum pacote será enviado ao registro sem uma release explícita. Para atualizar ou remover essa instalação, consulte [UPGRADE.md](UPGRADE.md).

Abra [http://127.0.0.1:3000](http://127.0.0.1:3000). Em uma instalação nova, o assistente inicial cria o administrador local e identifica o workspace. Depois, a área **Configurações** permite cadastrar a equipe e parear o WhatsApp por QR Code. O login é local; não existe conta hospedada pelo projeto. Use esse endereço exato para que a sessão permaneça no mesmo host da API local.

### CLI headless para agentes

O contrato instalado pode ser descoberto sem abrir o banco ou iniciar uma sessão de IA:

```bash
threadmark capabilities --json
threadmark agent triage-status --json
threadmark operators list --json
threadmark tickets get '#123' --json
threadmark conversations list --query 'nome do grupo' --json
```

Leituras são executadas diretamente. Escritas exigem o JSON da operação, `--apply` e um usuário ativo para auditoria:

```bash
threadmark tickets status '#123' \
  --input /caminho/privado/status.json \
  --apply --as operador-id --client hermes --json
```

Use arquivo com permissão privada ou stdin para conteúdo de atendimento. Não coloque mensagens, IDs reais, tokens ou payloads locais no repositório. A API registra a alteração com a origem do agente e continua aplicando papéis, validações, transições de status e idempotência do domínio. Consulte a [ADR 0004](docs/decisions/0004-headless-agent-cli.md) para o fluxo de migração.

Por compatibilidade, uma instalação nova começa com `SUPPORT_AGENT_EXECUTOR=internal`. Depois de configurar um executor Hermes que reivindique, renove e conclua a fila de triagem pela CLI, altere essa opção local para `hermes`. Nesse modo o agendador continua produzindo jobs a partir das mensagens inbound, mas o Threadmark não executa modelos internamente nem disputa o mesmo job com o Hermes.

## Como o aplicativo para macOS funciona

O shell desktop reutiliza a interface React, os componentes shadcn/ui e o Tailwind existentes. No modo padrão, abrir o aplicativo inicia ou reutiliza o daemon local, sem criar um segundo SQLite ou outra captura do WhatsApp. Fechar a janela encerra somente a interface; o serviço local pode continuar capturando mensagens como já acontece com `threadmark on`.

### Desenvolvimento e empacotamento

Durante o desenvolvimento:

```bash
npm run desktop:dev
```

Para gerar um `.app` local sem instalador ou um DMG:

```bash
npm run desktop:pack
npm run desktop:dist
```

Para executar todas as verificações de release, gerar o DMG, inspecionar o aplicativo montado e produzir o checksum:

```bash
npm run release:desktop
```

Os artefatos ficam em `release/` e não entram no Git. Uma tag `vX.Y.Z` correspondente à versão de `package.json` aciona o workflow de Developer Preview, que repete essas validações antes de anexar o DMG e seu checksum à release. A configuração **Aplicativo** oferece os modos:

- **Nesta máquina:** mantém SQLite, anexos, WhatsApp e automações internas no Mac atual;
- **Servidor remoto:** conecta o aplicativo a uma origem HTTPS compatível, sem migrar ou apagar o workspace local.

O cliente remoto é uma fundação para a edição hospedada. O servidor multiusuário empacotado, provisionamento de VPS, domínio, TLS e atualização remota serão entregues em uma fase própria; informar uma URL qualquer não transforma a instalação local atual em serviço hospedado.

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

Não coloque tokens, senhas, pastas de código ou conexões técnicas no `.env.example`. Configure esses recursos no perfil privado do Hermes ou do agente escolhido. Skills e credenciais específicas da organização não entram no SQLite nem no Git do Threadmark. Instalações antigas podem manter os registros legados preservados durante a migração, mas eles não são oferecidos na interface nova.

## Pareamento e grupos

1. Inicie o serviço com `threadmark on` (ou `npm run support:on` durante o desenvolvimento).
2. Escaneie o QR Code exibido na configuração ou no terminal.
3. Aguarde a descoberta dos grupos.
4. Escolha os grupos monitorados pela interface ou pelo comando `threadmark monitor <jid>`.
5. Cadastre os números, JIDs ou LIDs da equipe para que suas mensagens sejam apenas contexto.
6. Para medir uma possível revisão de mensagens já salvas, execute `threadmark rescan --days=30`. O comando mostra somente uma prévia: não altera mensagens, não reabre a fila e não chama nenhum modelo.

Com a lista de grupos monitorados vazia, o sistema opera em modo descoberta: salva o que for recebido, mas não abre candidatos de ticket para os grupos.

Mensagens privadas novas só entram na triagem quando o remetente está vinculado a pelo menos um grupo conhecido. Histórico privado antigo e contatos sem vínculo permanecem armazenados apenas como contexto.

## Diretório

O Diretório apresenta as identidades capturadas pelo WhatsApp:

- **grupos** exibem monitoramento, participantes, tickets e atividade recente;
- **pessoas** preservam nome, telefone, participação nos grupos e identificação da equipe;
- aliases de telefone e LID são consolidados para evitar participantes duplicados.

O Diretório não cria uma taxonomia comercial adicional. A organização operacional das demandas acontece nos tickets, categorias, responsáveis e prioridades.

## Hermes, skills e triagem

O Threadmark não oferece mais chat de IA, seleção de modelo, cadastro de ferramentas, apps externos ou geração de documentação na interface. Essas responsabilidades pertencem ao Hermes — ou a outro agente compatível — junto das skills, memória pessoal, credenciais e integrações da organização. Isso evita misturar conhecimento privado de uma equipe com o produto que outras pessoas podem clonar.

O agente conversa com o usuário no terminal e usa `threadmark capabilities --json` para descobrir o contrato. Leituras não pedem confirmação adicional. Escritas usam operações de domínio específicas, `--apply` e uma identidade ativa; a API continua validando papel, IDs, transições e idempotência e registra a origem como Hermes. O agente nunca recebe o token local nem acesso direto ao SQLite.

A triagem automática continua aparecendo em **Conversas**. O scheduler do Threadmark cria jobs a partir das mensagens inbound; no modo `SUPPORT_AGENT_EXECUTOR=hermes`, um executor externo reivindica um job com lease, recebe somente o recorte limitado e devolve um JSON validado. O resultado é uma sugestão revisável: não cria ticket e não envia WhatsApp. O operador ainda pode separar assuntos, ajustar categorias, criar, anexar, ignorar ou manter mensagens como contexto.

Investigações profundas usam as ferramentas configuradas no próprio ambiente do Hermes, como Git, Linear, bancos readonly, logs e AWS. A segurança deve existir na credencial e na tool — por exemplo, um usuário PostgreSQL realmente readonly — e não apenas no prompt. Quando uma correção exigir alterar o Threadmark, o Hermes usa a CLI; ações em sistemas externos seguem as permissões e confirmações daquele ambiente.

Dados antigos do Threadmark AI, documentos e conexões permanecem no SQLite por compatibilidade e recuperação, mas não são apresentados na interface. A remoção física desses registros exige uma migração futura, explícita e acompanhada de backup.

## Uso diário

```bash
threadmark on             # inicia API, Web UI, captura e scheduler local
threadmark open           # abre a Web UI
threadmark status         # mostra o estado local
threadmark doctor         # verifica processo, API, Web, SQLite, WhatsApp e disco
threadmark capabilities --json
threadmark tickets list --json
threadmark agent triage-status --json
threadmark off            # encerra os processos com segurança
```

`npm link` registra o executável local `threadmark` sem copiar dados ou configurações.
Use `threadmark configure` para escolher uma área operacional, ou abra diretamente
`threadmark configure whatsapp` e `threadmark configure team`. Modelos, skills,
ferramentas e integrações externas são configurados no Hermes.

No macOS, o serviço opcional inicia após o login e recupera falhas do processo:

```bash
threadmark service install
threadmark service status
threadmark service uninstall # preserva banco, anexos e configurações
```

O watchdog interno recupera somente a Web UI com backoff quando ela cai; API, captura e
workers continuam ativos. O arquivo `logs/daemon.log` dentro de `SUPPORT_DATA_DIR` é rotacionado de forma conservadora
ao atingir 5 MiB, mantendo cinco gerações.

`threadmark on` confirma a identidade da API antes de abrir ou migrar o SQLite e só anuncia sucesso após API e assets Web estarem prontos. `threadmark off` solicita shutdown pela API com o token desta instalação; ele nunca encerra um PID apenas porque apareceu num arquivo antigo. O Doctor testa somente os componentes locais ativos; os modelos e as ferramentas externas são diagnosticados no ambiente do agente.

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

Sessão do WhatsApp, credenciais externas e caches de modelos são deliberadamente excluídos dos backups; depois de restaurar em outra máquina, reconecte o WhatsApp e restaure separadamente o perfil privado do agente. Guarde backups em destino criptografado e nunca os envie em relatórios de bug.

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
- `server/agent/`: executor interno legado e contratos compatíveis preservados durante a migração.
- `server/headless/`: contrato CLI versionado usado por Hermes e outros agentes externos.
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
- [Decisão sobre o aplicativo desktop](docs/decisions/0003-desktop-local-and-remote-workspaces.md)
- [Atualização, rollback e desinstalação](UPGRADE.md)
- [Política de segurança](SECURITY.md)
- [Guia de contribuição](CONTRIBUTING.md)
- [Código de Conduta](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Contrato interno do conector WhatsApp](server/whatsapp/README.md)
- [Convenções para agentes de código](AGENTS.md)

## Licença

Threadmark é distribuído sob a [licença MIT](LICENSE). Copyright © 2026 Weslem Vitor.
