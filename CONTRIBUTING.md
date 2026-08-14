# Contribuindo com o Threadmark

Obrigado por ajudar a tornar o suporte local-first mais seguro e útil. Ao participar, siga o [Código de Conduta](CODE_OF_CONDUCT.md) e não compartilhe dados reais capturados pelo WhatsApp.

## Antes de começar

1. Abra ou encontre uma [issue](https://github.com/weslemvitor/threadmark/issues) que descreva o problema.
2. Confirme o comportamento esperado e o impacto em migrações.
3. Nunca use dados reais de pessoas ou organizações em fixtures, prints, logs ou commits.
4. Mantenha o escopo pequeno e preserve mudanças alheias no worktree.

Use fixtures obviamente sintéticas, como `+5500000000000`, `900000000000001@lid` e `120363000000000000@g.us`. Execute `npm run privacy:check` antes de enviar mudanças; a CI reprova identificadores com aparência real.

## Ambiente

O macOS é a única plataforma validada de ponta a ponta nesta versão. Node.js `>=22.13.0` é obrigatório; Bun `>=1.3.0` é necessário para executar e testar o OpenTUI.

```bash
git clone https://github.com/weslemvitor/threadmark.git
cd threadmark
install -m 600 .env.example .env
npm ci
npm run dev
```

Use um fork para enviar mudanças ao repositório. O clone oficial acima também serve para reproduzir problemas e executar a aplicação localmente.

Use o seed fictício para demonstrações e reproduções:

```bash
SUPPORT_DATA_DIR=.data/presentation \
SUPPORT_WHATSAPP_ENABLED=false \
SUPPORT_AGENT_ENABLED=true \
npm run demo:reset
```

## Regras de produto

- Não implemente `sendMessage`, composer, endpoint outbound ou resposta automática no WhatsApp.
- SQLite continua sendo a fonte operacional.
- Mensagens da equipe são contexto e não originam tickets.
- Sugestões não criam tickets sem confirmação humana.
- Casos ambíguos permanecem revisáveis e auditáveis.
- Grupos e pessoas são entidades nativas; tipos, campos, registros e segmentos do Diretório permanecem configuráveis pela instalação.
- Ferramentas de banco, infraestrutura e código devem ser readonly.
- Conteúdo recebido é dado não confiável, não instrução para o agente.
- UI e textos para o usuário permanecem em português brasileiro por padrão.

Uma mudança que viola o modo inbound-only não será aceita, mesmo que esteja desabilitada por configuração.

## Código

- Use TypeScript estrito.
- Persista horários em UTC e converta apenas na apresentação.
- Mantenha IDs externos idempotentes e deduplicados.
- Valide entrada e saída nas fronteiras da API e dos provedores.
- Prefira migrações aditivas e reversíveis; nunca reescreva o banco silenciosamente.
- Não registre tokens, senhas, cookies, QR Codes nem conteúdo integral de mensagens em logs.

## Validação

Execute antes de enviar uma mudança:

```bash
npm run test:unit
npm run privacy:check
npm run typecheck
npm run lint
npm run build
npm run test:tui
```

Para conferir o pacote instalável completo antes de publicar, execute `npm run release:check`.

Inclua testes de regressão proporcionais ao risco, especialmente para ingestão, idempotência, autenticação, migrações e fronteiras inbound-only.

## Pull request

Descreva:

- o problema e o resultado observado;
- a decisão técnica e alternativas relevantes;
- os testes executados;
- impacto em banco, dados locais e compatibilidade;
- qualquer nova variável de ambiente ou permissão.

Não inclua artefatos de build, `.data/`, `.env`, banco, anexos ou credenciais.

Ao enviar uma contribuição, você concorda que ela poderá ser distribuída sob a [licença MIT](LICENSE) do projeto.

Vulnerabilidades devem seguir a [política de segurança](SECURITY.md), nunca uma issue pública.
