# Atualização e desinstalação

Threadmark pode ser instalado pelo DMG da Developer Preview ou executado a partir do código-fonte. O aplicativo e os dados locais ficam separados: substituir `/Applications/Threadmark.app` não remove o workspace armazenado em `~/Library/Application Support/Threadmark`.

## Antes de atualizar

1. Confirme a saúde atual em **Configurações → Dados** ou, numa instalação pelo código-fonte:

   ```bash
   threadmark doctor
   ```

2. Crie um backup completo pela mesma tela ou pela CLI e valide o resultado:

   ```bash
   threadmark backup --full
   threadmark backups list
   ```

3. No aplicativo, escolha **Threadmark → Encerrar aplicativo e serviço local…**. Essa opção interrompe a captura, as automações e os jobs antes da troca do `.app`. Na instalação pelo código-fonte, use:

   ```bash
   threadmark off
   ```

O backup integrado inclui SQLite, configurações não secretas e, no modo completo, anexos. Ele não inclui sessão do WhatsApp, chaves de IA nem credenciais de ferramentas.

O cache dos modelos locais de transcrição também não entra no backup. As transcrições já salvas permanecem no SQLite, mas o modelo precisa ser baixado novamente em outra máquina.

## Atualizar o aplicativo

1. Baixe o novo DMG e o arquivo `.sha256` na [release oficial](https://github.com/weslemvitor/threadmark/releases).
2. Valide os arquivos na mesma pasta, substituindo o nome pela versão baixada:

   ```bash
   shasum -a 256 -c Threadmark-0.3.0-arm64.dmg.sha256
   ```

3. Execute **Threadmark → Encerrar aplicativo e serviço local…** na versão atual.
4. Abra o DMG e substitua `Threadmark.app` em **Aplicativos**.
5. Como a Developer Preview ainda não é assinada, remova a quarentena apenas depois de validar a origem e o checksum:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Threadmark.app"
   open -a Threadmark
   ```

6. Confirme o login, a captura e a saúde do workspace. Migrações pendentes são aplicadas ao primeiro início e criam um snapshot versionado do SQLite antes de alterar o banco.

Não existe atualização automática nesta fase. O download e a substituição do aplicativo são sempre explícitos.

## Atualizar uma instalação pelo código-fonte

A versão `0.3.x` não é publicada no registro npm. `npm link` cria o comando global `threadmark` apontando para o clone local; não mova nem apague esse diretório enquanto quiser usar o comando.

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

Se uma atualização do aplicativo falhar, encerre o serviço, substitua o `.app` pela versão anterior obtida na release oficial e abra novamente. Se a falha ocorreu depois de alterar o banco, restaure o backup ou snapshot pré-migração pela interface.

Para uma instalação pelo código-fonte:

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

No aplicativo, use **Threadmark → Encerrar aplicativo e serviço local…** e mova `Threadmark.app` para o Lixo. O workspace em `~/Library/Application Support/Threadmark` permanece intacto.

Numa instalação pelo código-fonte:

```bash
threadmark off
threadmark service uninstall
npm unlink --global threadmark
```

`threadmark service uninstall` é aplicável apenas quando o LaunchAgent opcional foi instalado no macOS. Os comandos não removem o clone nem o `SUPPORT_DATA_DIR`. Guarde um backup validado antes de mover ou apagar qualquer um deles.

## Apagar a instalação e os dados

Depois de desinstalar o comando, confirme o caminho exato de `SUPPORT_DATA_DIR`, verifique se existe alguma obrigação de retenção e remova manualmente o clone, o diretório de dados e os backups externos que também devam ser eliminados. Essa ação apaga mensagens, anexos, sessão do WhatsApp, credenciais locais e auditoria e não pode ser desfeita sem backup.
