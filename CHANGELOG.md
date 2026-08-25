# Changelog

As mudanças relevantes do Threadmark são registradas neste arquivo. O projeto segue
[Versionamento Semântico](https://semver.org/lang/pt-BR/) e o formato do
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não publicado]

## [0.3.0] - 2026-08-25

### Adicionado

- Aplicativo para macOS Apple Silicon com workspace local padrão e conexão opcional a uma origem HTTPS compatível.
- Empacotamento de Developer Preview em DMG, inspeção automatizada do artefato e checksum SHA-256 publicado junto da release.
- Comando no menu do aplicativo para encerrar com segurança a interface e o serviço local antes de uma atualização.

### Segurança

- Renderer desktop isolado, sem integração Node, com sandbox, permissões negadas e navegação restrita ao workspace selecionado.
- Pipeline de release repete testes, auditoria de privacidade, build e inspeção do DMG antes de publicar qualquer artefato.

### Removido

- Cockpit OpenTUI, dependência nativa, comando `threadmark tui` e testes específicos. A Web UI permanece como interface operacional e a CLI continua responsável pelo ciclo de vida e diagnóstico.

## [0.2.0] - 2026-08-07

### Adicionado

- Transcrição opcional de áudios OGG/Opus com modelos Whisper executados localmente, indicadores de RAM e disco, fila persistida e processamento individual ou em lote.
- Espera da triagem por transcrições realtime, evitando sugestões de ticket sem o conteúdo do áudio.

### Alterado

- O Kanban passa a ser a entrada única dos tickets; cada card abre o contexto completo em uma página própria, preservando conversa, notas, categorias e sala de investigação.
- A busca global e a criação manual de tickets permanecem acessíveis sem uma listagem lateral separada.
- A seleção manual da conversa mantém apenas as ações de contexto e restauração; sugestões incorretas da IA continuam descartáveis sem apagar mensagens.

### Removido

- Biblioteca interna de bases de conhecimento, incluindo tela, API, armazenamento e injeção automática no contexto da IA. Ferramentas locais configuráveis continuam disponíveis.

### Corrigido

- O contexto isolado do ticket preserva a última mensagem visível e mantém o compositor de notas fixo no fluxo da página.
- O switch do shadcn/ui reflete corretamente o estado visual marcado e desmarcado.

## [0.1.0] - 2026-07-19

### Adicionado

- Captura local e estritamente inbound de conversas do WhatsApp com Baileys.
- Timeline permanente de grupos e conversas privadas elegíveis, incluindo imagens, documentos, respostas citadas e reações.
- Triagem supervisionada, seleção explícita de mensagens e tickets com Kanban e arquivamento.
- Diretório agnóstico com grupos, pessoas, tipos de registro, campos personalizados, relações e segmentos.
- Dashboard por período e exportação.
- Perfis de IA configuráveis para sugestão, análise inicial e investigação profunda.
- Broker local de ferramentas readonly com auditoria persistida.
- Web UI, CLI `threadmark` e cockpit OpenTUI.
- Backup validado, restauração com backup de segurança e snapshot automático antes de migrações.

### Segurança

- Nenhuma superfície de envio de mensagens pelo WhatsApp.
- API e Web UI limitadas a loopback por padrão.
- Credenciais cifradas fora do SQLite e excluídas dos backups integrados.

[0.3.0]: https://github.com/weslemvitor/threadmark/releases/tag/v0.3.0
[0.2.0]: https://github.com/weslemvitor/threadmark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/weslemvitor/threadmark/releases/tag/v0.1.0
