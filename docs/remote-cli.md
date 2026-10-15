# CLI remota

A CLI encaminha somente operações headless para uma instância Threadmark cadastrada. O transporte recomendado é HTTPS direto para a API publicada pela aplicação. O transporte SSH existente permanece disponível para compatibilidade operacional.

Nenhum destino armazena senha ou token em `remotes.json`. Destinos HTTPS guardam a credencial revogável no macOS Keychain; destinos SSH dependem do alias e do agente SSH já configurados localmente.

## HTTPS direto

### 1. Instale a CLI no computador do agente

Se o Threadmark está na VPS e o Codex roda no seu Mac, instale e autentique a CLI no Mac. Nesta versão, o login HTTPS depende do macOS Keychain.

Com Git e Node.js 22.13 ou superior instalados:

```sh
git clone https://github.com/weslemvitor/threadmark.git
cd threadmark
npm install
npm run package:build
npm link
threadmark --version
```

Se `threadmark --version` já funciona, siga para a criação da credencial.

### 2. Crie a credencial

Crie uma credencial em **Configurações → Segurança → CLI**. A mesma CLI atende uso manual, Codex, Hermes e outros agentes, sem escolher um cliente ao gerar o token ou executar comandos. Usuários ativos com papel `owner`, `admin` ou `operator` podem criar e revogar somente as próprias credenciais. O token é exibido uma única vez e o servidor persiste somente seu hash. A credencial fica vinculada ao usuário que a criou, possui escopo `headless`, expiração obrigatória e revogação individual. Desativar o usuário ou alterar seu papel revoga definitivamente suas credenciais.

O guia de conexão aparece abaixo do token, somente após a criação bem-sucedida. Credenciais antigas continuam válidas até expirar ou serem revogadas. O campo legado `clientId` e a opção `--client` são aceitos por compatibilidade, mas não escolhem identidade ou permissões por agente.

### 3. Cadastre a instalação e faça login

Cadastre o domínio e salve o token no Keychain:

```sh
threadmark remote add production --url https://threadmark.exemplo.com
threadmark remote login production
```

`remote login` abre duas solicitações seguras do macOS Keychain; cole o mesmo token emitido pela interface nas duas para confirmar. O token não é passado em argumentos de processo, não entra em variáveis de ambiente e não é gravado no cadastro remoto. A referência do Keychain combina o nome e a URL canônica do remoto, evitando reutilizar o token se o mesmo nome for recadastrado para outro servidor.

### 4. Teste a conexão

```sh
threadmark remote status production --json
threadmark --remote production capabilities --json
threadmark --remote production tickets list --json
```

O status deve identificar sua credencial e seu usuário. Os próximos comandos retornam as capacidades e a lista de tickets. Uma lista vazia também é uma resposta válida.

### 5. Use pelo Codex ou outro agente

Abra um chat local no mesmo computador, com acesso ao terminal, e envie:

```text
Use a CLI Threadmark instalada neste computador para acessar o remoto production.
Use sempre o prefixo threadmark --remote production e a saída --json.
Consulte as capacidades disponíveis e liste os tickets que precisam de atenção.
Faça somente consultas nesta etapa; peça minha autorização antes de alterar dados.
Se a conexão falhar, informe o erro e não use uma instância local como alternativa.
```

Se o agente não encontrar o executável, informe o caminho retornado por `command -v threadmark` no seu terminal. O agente precisa executar a CLI com acesso ao mesmo cadastro remoto e ao Keychain do usuário que fez o login.

### Revogação e limites de acesso

Para revogar a credencial no servidor e removê-la do Keychain:

```sh
threadmark remote logout production --json
```

A API aceita essa credencial somente nos pares de método e rota usados pela família headless. Ela não autoriza runtime, shutdown, usuários, configurações, backup ou acesso ao banco. A identidade delegada de uma escrita deve ser o mesmo usuário vinculado à credencial. A identidade e as permissões são as do usuário vinculado ao token, independentemente do agente que executa a CLI.

HTTP sem TLS é recusado, exceto em loopback (`localhost`, `127.0.0.1` ou `::1`) para desenvolvimento local. A URL deve apontar para a origem, sem caminho adicional, query string, fragmento ou credenciais.

## SSH legado

A CLI também pode encaminhar operações headless para uma instância que roda em um container Docker acessível por um alias SSH local. Ela não cria servidores, não instala chaves, não copia credenciais e não configura a instância remota.

### Cadastro local

Cadastre um nome de destino, um alias já existente em `~/.ssh/config` e o nome exato do container:

```sh
threadmark remote add production --ssh threadmark-prod --container threadmark-production
threadmark remote list --json
```

O cadastro contém apenas `name`, `ssh` e `container`. Por padrão ele fica em:

- `$XDG_CONFIG_HOME/threadmark/remotes.json`, quando `XDG_CONFIG_HOME` contém um caminho absoluto;
- `~/.config/threadmark/remotes.json`, caso contrário.

O arquivo é gravado com modo `0600`; o diretório dedicado criado pela CLI usa modo `0700`. `THREADMARK_REMOTE_CONFIG_PATH` é uma substituição para testes e integrações locais isoladas. `threadmark remote remove NAME` remove apenas esse registro local — nunca conecta ao servidor nem remove um container.

### Lock de edição e recuperação manual

Alterações no cadastro usam o diretório de lock `${caminho-do-arquivo}.lock` e falham fechadas após dois segundos se ele já existir. Um processo encerrado abruptamente pode deixar esse diretório para trás. O erro `remote_config_busy` informa o caminho exato; não há remoção automática, takeover por TTL ou comando de desbloqueio.

Antes de remover um lock, **verifique primeiro que nenhuma edição de registro usando este arquivo está ativa** — não pode haver um `threadmark remote add` ou `threadmark remote remove` em andamento. Listagens, leituras de registro (`remote list` e `getRemote`) e operações remotas headless continuam disponíveis enquanto uma edição do cadastro estiver bloqueada.

Depois dessa verificação, remova **somente** o diretório de lock vazio com `rmdir`, usando o caminho correto:

- se `THREADMARK_REMOTE_CONFIG_PATH` estiver definido, use `${THREADMARK_REMOTE_CONFIG_PATH}.lock` (a CLI resolve um override relativo a partir do diretório de onde ela foi executada);
- caso contrário, se `XDG_CONFIG_HOME` contiver um caminho absoluto, use `$XDG_CONFIG_HOME/threadmark/remotes.json.lock`;
- caso contrário, use `~/.config/threadmark/remotes.json.lock`.

Por exemplo, depois de confirmar que não há editor ativo:

```sh
rmdir -- "/caminho/exato/para/remotes.json.lock"
```

`rmdir` deve falhar se o diretório não estiver vazio. **Nunca use `rm -rf` e nunca remova um lock de um processo ativo.**

Use aliases SSH para manter host, usuário e chave no cliente local. Não inclua senha, token, `usuario@host`, flags SSH ou dados de credencial no registro.

## Uso

O seletor remoto deve ser o prefixo único da chamada:

```sh
threadmark --remote production tickets list --json
threadmark --remote production conversations list --limit 25 --json
threadmark --remote production tickets status ticket-123 \
  --input update.json --apply --as "Pessoa Operadora" --json
```

A última chamada lê `update.json` no computador que invocou a CLI e o encaminha pela entrada padrão ao container como `--input -`; o caminho local nunca é enviado ao host remoto. A entrada é limitada a 64 KiB. `--input -` encaminha a entrada padrão local diretamente. Escritas continuam exigindo `--apply`, `--as`; a instância remota mantém a mesma resolução de ator e auditoria headless.

São aceitas as famílias headless: `capabilities`, `operators`, `conversations`, `triage`, `tickets`, `categories`, `clients`, `dashboard` e `agent`. A CLI rejeita explicitamente comandos de ciclo de vida ou dados locais, como `on`, `off`, `start`, `stop`, `restore`, `service`, `backup`, `backups`, `configure` e similares. Não há fallback automático para a instância local quando um remoto não existe ou falha.

## Transporte SSH e limites

A chamada remota executa, por SSH, o equivalente seguro a:

```text
docker exec -i <container-configurado> node /app/bin/threadmark.mjs <comando-headless...>
```

Cada argumento é citado para POSIX e `ssh` é iniciado sem shell local. O transporte usa modo não interativo, verificação estrita de chave do host, uma única tentativa de conexão, timeout de conexão e keepalive limitado; encaminhamento de agente e outros encaminhamentos são desativados. `ProxyJump`, `IdentityFile` e demais escolhas já confiadas ao alias em `~/.ssh/config` continuam disponíveis.

O nome do container é exato. Recriações do Coolify ou do Docker podem mudar esse nome; atualize o registro local se isso acontecer. A CLI não tenta descobrir, escolher ou iniciar outro container. Não repete automaticamente uma chamada que falhou, inclusive escritas ambíguas. Saída padrão JSON e código de saída do comando remoto são preservados; com `--json`, falhas de transporte também usam um envelope JSON de erro quando não houver um erro headless já produzido pelo container.

Esta integração **não é um sandbox SSH** nem garante uma conta remota restrita. Restrinja o alias e as permissões do host/Docker de acordo com a política da operação. O uso correto depende de chaves, `known_hosts`, conta e daemon Docker protegidos fora do Threadmark.
