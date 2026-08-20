# Política de segurança

## Como reportar

Não abra uma issue pública para vulnerabilidades, credenciais expostas ou dados de terceiros. Envie o relato pelo formulário privado de [Security Advisory do Threadmark](https://github.com/weslemvitor/threadmark/security/advisories/new) e inclua uma reprodução mínima sem dados reais.

Se o formulário não estiver disponível, abra uma issue solicitando contato privado, sem descrever a vulnerabilidade. Não envie banco, auth state do WhatsApp, tokens, QR Codes, anexos, snapshots do diretório de dados ou logs completos.

Inclua, quando possível, a versão ou commit, sistema operacional, impacto, passos mínimos de reprodução e uma sugestão de correção. Remova identificadores e use o ambiente de demonstração para produzir evidências compartilháveis.

## Escopo prioritário

- qualquer caminho que envie mensagens ou execute ações outbound;
- bypass de autenticação local ou elevação de papel;
- exposição de chaves, sessões, banco ou anexos;
- path traversal em anexos e raízes de conhecimento/código;
- prompt injection que atravesse a fronteira de dados não confiáveis;
- execução de comando ou mutação de banco/infraestrutura pela investigação;
- acesso remoto inesperado a listeners configurados como locais;
- dependências ou build scripts comprometidos.

## Invariantes

- WhatsApp é estritamente inbound-only.
- A API escuta em loopback por padrão.
- Segredos e estado privado nunca entram no Git.
- Sugestões de ticket não recebem ferramentas de execução, mesmo quando usam o Codex CLI.
- A transcrição usa somente o áudio local e o modelo instalado; o download do modelo não envia conversas ou anexos ao provedor do arquivo.
- A investigação profunda não recebe shell, MCP, HOME pessoal, credenciais ou acesso direto a recursos locais.
- Ferramentas profundas são executadas por um broker tipado somente após validar ID, estado, escopo e operação readonly.
- Arquivos de ambiente, sessões, credenciais, chaves e certificados são recusados mesmo quando estão sob uma raiz autorizada.
- Evidência técnica só sustenta uma conclusão quando referencia exatamente uma operação local concluída com sucesso e registrada em auditoria append-only.
- Segredos de provedores e ferramentas ficam cifrados fora do SQLite e nunca são incluídos no prompt ou na resposta da API.
- Resultados do modelo são validados antes de serem persistidos como estruturas do domínio.
- Inicialização e shutdown confirmam a identidade da instalação por API autenticada; nenhum processo é encerrado confiando apenas num PID persistido.

## Boas práticas para operadores

- Atualize Node.js e as dependências regularmente.
- Revise `npm run audit:runtime` e alterações no lockfile.
- Advisories transitivos sem atualização compatível só podem ser reconhecidos explicitamente em `bin/npm-audit-runtime.mjs`; qualquer vulnerabilidade alta ou crítica nova continua bloqueando a CI.
- Use criptografia de disco e backups criptografados.
- Não exponha a porta da API diretamente à rede.
- Restrinja permissões do diretório de dados ao usuário do serviço.
- Cadastre chaves apenas no armazenamento local indicado pela aplicação.
- Use usuários realmente readonly em PostgreSQL/ClickHouse e políticas IAM/Vercel de menor privilégio; os bloqueios do executor são uma camada adicional, não substituem permissões da origem.
- Trate mensagens, anexos e conhecimento importado como conteúdo não confiável; os modos automáticos devem continuar sem shell, MCP, navegador, plugins ou codebase.
- Faça rotação imediata de qualquer credencial que apareça em log ou commit.

## Suporte de versões

| Linha | Correções de segurança |
| --- | --- |
| Release publicada mais recente | Sim |
| `main` | Melhor esforço; pode conter mudanças ainda não lançadas |
| Releases anteriores | Não, salvo anúncio explícito |

Instalações derivadas devem acompanhar o [changelog](CHANGELOG.md), manter backups validados e possuir um plano próprio de atualização. Consulte [UPGRADE.md](UPGRADE.md) para o procedimento suportado.
