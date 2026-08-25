# ADR 0003: Shell desktop com workspaces locais e remotos

## Status

Aceita em 2026-08-25. O modo local é a primeira entrega; a distribuição do servidor remoto permanece incremental.

## Contexto

O Threadmark já possui uma Web UI React, API Node, captura Baileys, SQLite e workers locais. Reescrever a interface como aplicação nativa duplicaria componentes, regras e testes. Ao mesmo tempo, abrir terminal e navegador não é o fluxo desejado para operadores, e uma equipe futura precisa conectar o mesmo cliente a uma instalação hospedada sem acessar a VPS por SSH.

## Decisão

- Empacotar a interface existente com Electron no macOS.
- Preservar React, shadcn/ui, Tailwind e o servidor Node atuais.
- Manter `local` como perfil padrão e iniciar ou reutilizar o daemon existente.
- Permitir um perfil `remote` apontando apenas para uma origem HTTPS compatível.
- Nunca migrar ou apagar o workspace local ao trocar de perfil.
- Executar o renderer sem integração Node, com isolamento de contexto, sandbox, permissões negadas e navegação limitada.
- Manter o ciclo de vida pesado no servidor; Electron controla somente janela, perfil e inicialização.
- Distribuir futuramente o servidor como um artefato separado do `Threadmark.app`.
- Distribuir a fase Developer Preview como DMG `arm64` sem assinatura, acompanhado de checksum SHA-256 e instrução explícita de quarentena. Assinatura e notarização continuam sendo o destino da edição estável.
- Oferecer no menu do aplicativo uma saída que também encerra o daemon local, destinada a atualizações e manutenção.

## Consequências

- O usuário abre o Threadmark pelo Dock, Finder ou Spotlight sem abandonar a UI atual.
- O banco local e a sessão do WhatsApp permanecem compatíveis com a CLI e o LaunchAgent existentes.
- Fechar a janela não interrompe necessariamente captura, automações ou jobs em andamento.
- Um membro da equipe poderá instalar apenas o cliente e entrar num workspace hospedado por HTTPS, sem usar SSH.
- A edição hospedada ainda exige domínio, TLS, backups, autenticação remota, instalação do servidor e política de atualização.
- A Developer Preview exige uma exceção manual do Gatekeeper com `xattr`; esse procedimento é menos conveniente e deve ser usado somente depois de validar a origem oficial e o checksum.
- Cada atualização é manual. O operador encerra o daemon pelo menu antes de substituir o `.app`, enquanto o workspace permanece fora do pacote.
- O runtime local permanece fora de ASAR porque a CLI inicia processos filhos
  (`tsx`, Vinext e módulos nativos). ASAR não é tratado como barreira de
  confidencialidade; os dados privados continuam fora do pacote, no diretório
  local protegido do usuário.
