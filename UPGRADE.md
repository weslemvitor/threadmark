# Atualização e desinstalação

Threadmark é distribuído a partir do código-fonte. A versão `0.2.x` não é publicada como pacote no registro npm: `npm link` cria o comando global `threadmark` apontando para o clone local. O empacotamento global é testado apenas para preparar uma publicação futura. Não mova nem apague esse diretório enquanto quiser usar o comando.

## Antes de atualizar

1. Confirme a saúde atual:

   ```bash
   threadmark doctor
   ```

2. Crie um backup completo e valide o resultado:

   ```bash
   threadmark backup --full
   threadmark backups list
   ```

3. Pare os processos com segurança:

   ```bash
   threadmark off
   ```

O backup integrado inclui SQLite, configurações não secretas e, no modo completo, anexos. Ele não inclui sessão do WhatsApp, chaves de IA nem credenciais de ferramentas.

O cache dos modelos locais de transcrição também não entra no backup. As transcrições já salvas permanecem no SQLite, mas o modelo precisa ser baixado novamente em outra máquina.

## Atualizar o código

No diretório do repositório:

```bash
git pull --ff-only
npm ci
npm run build
npm link
threadmark on
threadmark doctor
```

Na primeira inicialização após uma atualização, migrações pendentes são aplicadas ao SQLite. Antes de migrar, o Threadmark cria automaticamente um snapshot versionado do banco. Não interrompa a inicialização durante essa etapa.

Consulte o [CHANGELOG.md](CHANGELOG.md) antes de atualizar para identificar mudanças de comportamento, requisitos ou procedimentos adicionais.

## Reverter uma atualização

Se uma atualização falhar depois de alterar o banco:

1. Pare o Threadmark com `threadmark off`.
2. Localize o backup completo ou pré-migração com `threadmark backups list`.
3. Restaure o backup com `threadmark restore <id>`.
4. Volte para a tag anterior conhecida com `git checkout <tag-anterior>`.
5. Execute `npm ci`, `npm run build`, `npm link` e `threadmark on`.
6. Confirme o resultado com `threadmark doctor`.

Não tente reverter migrações editando o SQLite manualmente.

## Snapshot manual para mudança de máquina

Um snapshot manual do `SUPPORT_DATA_DIR` parado pode preservar também a sessão do WhatsApp e o cofre local. Isso o torna muito mais sensível que o backup integrado.

1. Execute `threadmark off`.
2. Confirme o caminho configurado em `SUPPORT_DATA_DIR`.
3. Copie o diretório inteiro para um destino criptografado e com acesso restrito.
4. Restaure e teste em uma máquina controlada antes de descartar a origem.

O arquivo de chave e o conteúdo cifrado do cofre ficam nessa cópia. Não envie o snapshot a issues, serviços de arquivos sem criptografia ou pessoas não autorizadas.

## Desinstalar preservando dados

```bash
threadmark off
threadmark service uninstall
npm unlink --global threadmark
```

`threadmark service uninstall` é aplicável apenas quando o LaunchAgent opcional foi instalado no macOS. Os comandos não removem o clone nem o `SUPPORT_DATA_DIR`. Guarde um backup validado antes de mover ou apagar qualquer um deles.

## Apagar a instalação e os dados

Depois de desinstalar o comando, confirme o caminho exato de `SUPPORT_DATA_DIR`, verifique se existe alguma obrigação de retenção e remova manualmente o clone, o diretório de dados e os backups externos que também devam ser eliminados. Essa ação apaga mensagens, anexos, sessão do WhatsApp, credenciais locais e auditoria e não pode ser desfeita sem backup.
