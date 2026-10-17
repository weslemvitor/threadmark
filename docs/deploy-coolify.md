# Deploy no Coolify

O Threadmark roda como uma aplicação stateful de réplica única. O container publica somente a Web UI na porta `3000`; requisições `/api/*` e `/health` são encaminhadas pela própria Web para a API privada em `127.0.0.1:4317`. O daemon principal também mantém WhatsApp, automações, scheduler, transcrição e demais workers no mesmo processo operacional.

## Configuração da aplicação

- Fonte: repositório Git do Threadmark.
- Build pack: Dockerfile.
- Dockerfile: `Dockerfile`.
- Porta interna: `3000`.
- Domínio: o domínio HTTPS público escolhido no Coolify.
- Health check: `GET /health`, porta `3000`.
- Réplicas: exatamente `1`.
- Estratégia de deploy: interromper a instância antiga antes de iniciar a nova. Não permita sobreposição entre releases.
- Volume persistente: volume nomeado ou storage do Coolify montado em `/app/data`.

SQLite, WAL/SHM, anexos, backups, sessão do WhatsApp, segredos, modelos e estado do runtime ficam juntos em `/app/data`. Nunca monte o mesmo volume em duas instâncias simultâneas.

## Variáveis

Configure em Runtime Environment Variables do Coolify:

```dotenv
SUPPORT_PUBLIC_ORIGIN=https://threadmark.exemplo.com
SUPPORT_WORKSPACE_NAME=Meu workspace
SUPPORT_WHATSAPP_NAME=Conta de suporte
SUPPORT_WHATSAPP_PHONE=commercial-account
SUPPORT_MONITORED_GROUPS=
SUPPORT_STAFF_IDENTITIES=
SUPPORT_WHATSAPP_ENABLED=true
SUPPORT_START_WEB=true
SUPPORT_TRIAGE_AI_ENABLED=true
SUPPORT_TRIAGE_AI_MODEL=gpt-5.4-mini
SUPPORT_TRIAGE_AI_QUIET_MS=180000
SUPPORT_AUDIO_TRANSCRIPTION_TIMEOUT_MS=600000
```

`SUPPORT_PUBLIC_ORIGIN` é obrigatória no deploy e deve corresponder exatamente à origem HTTPS, sem barra final. Ela controla CORS, proteção de origem e o atributo `Secure` do cookie. A origem interna da Web, hosts, portas e `SUPPORT_DATA_DIR` já são definidos pela imagem e não devem ser sobrescritos no Coolify.

A fila de triagem é consumida por um agente externo pela CLI. Sem um agente conectado, os jobs permanecem disponíveis, sem iniciar Codex ou outro modelo dentro do container. Os demais workers continuam no daemon. `SUPPORT_TRIAGE_AI_ENABLED=false` habilita somente o classificador determinístico local; não há executor interno para instalar.

Para conectar a CLI sem acesso SSH, crie uma credencial em **Configurações → Segurança → CLI**, cadastre o domínio público com `threadmark remote add NAME --url HTTPS_URL` e salve o token no macOS Keychain com `threadmark remote login NAME`. A mesma credencial atende uso manual e qualquer agente externo. A API restringe essa credencial às operações headless e o servidor persiste somente seu hash.

Não coloque tokens em build arguments nem em variáveis `NEXT_PUBLIC_*`.

## Primeiro deploy

1. Crie a aplicação e o volume antes de iniciar o primeiro container.
2. Configure o domínio, TLS, porta `3000`, variáveis e réplica única.
3. Faça o deploy e aguarde `/health` retornar HTTP 200.
4. Consulte os logs do primeiro início e copie o código de configuração inicial, válido por 30 minutos.
5. Abra o domínio, crie a conta administradora e pareie o WhatsApp pela tela de Configurações.
6. Reinicie o container e confirme que login, tickets, anexos e sessão do WhatsApp permanecem disponíveis.

## Migração de uma instalação existente

Pare completamente a instalação de origem antes da cópia. Transfira o diretório inteiro de `SUPPORT_DATA_DIR` para o volume montado em `/app/data`, preservando arquivos ocultos e permissões; não copie apenas `threadmark.sqlite`, pois o WAL/SHM e os demais arquivos formam a fronteira de consistência. Inicie somente uma instância e valide `/health`, login, integridade do SQLite, anexos e reconexão do WhatsApp.

## Backup e rollback

Use o backup integrado do Threadmark para snapshots consistentes. Copiar o volume com o serviço em execução não substitui um backup SQLite correto. Antes de atualizar, crie e valide um backup; para rollback após migração de schema, restaure o snapshot compatível antes de iniciar a imagem anterior.
