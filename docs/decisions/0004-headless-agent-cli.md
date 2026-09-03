# ADR 0004: Threadmark headless com Hermes como agente

## Status

Aceita e aplicada localmente em 2026-09-02. A UI operacional permanece ativa; as superfícies de agente foram ocultadas depois da validação do contrato headless e da fila externa.

## Contexto

O Threadmark acumulou duas responsabilidades diferentes:

- sistema operacional de suporte, com captura inbound, mensagens, tickets, categorias, usuários, Kanban, métricas e auditoria;
- ambiente de execução de agentes, com chat próprio, provedores, ferramentas, apps, prompts, skills, investigação e documentação.

Manter o segundo conjunto dentro da aplicação duplicava capacidades já oferecidas por agentes como o Hermes. Também ligava conhecimento privado e integrações de uma organização ao produto distribuído, tornando o comportamento difícil de reutilizar por outras instalações.

Ao mesmo tempo, remover a interface operacional eliminaria controles humanos importantes: revisar se uma conversa deve virar ticket, separar assuntos e mensagens, corrigir categorias e acompanhar o atendimento.

## Decisão

O Threadmark será o sistema operacional e a fonte de verdade. O Hermes será a superfície conversacional e o orquestrador de modelos, skills e ferramentas externas.

```text
Hermes / modelo / skills
  -> threadmark CLI
      -> API autenticada
          -> domínio e SQLite do Threadmark

Hermes
  -> Git, Linear, AWS, bancos readonly e outras ferramentas próprias

Threadmark Web/Desktop
  -> mesma API
      -> revisão visual, Kanban, categorias, usuários e dashboard
```

### Limite da CLI

- A CLI é uma fachada de domínio sobre a API; nunca orienta agentes a escrever diretamente no SQLite.
- Saídas usam envelopes JSON versionados, limites de paginação e códigos de erro estáveis.
- Leituras não exigem confirmação adicional.
- Escritas exigem `--apply` e uma identidade ativa com `--as`; a API valida a identidade e registra o cliente executor, como `Hermes · Pessoa Operadora`.
- Entradas grandes ou com conteúdo de atendimento usam arquivo privado ou stdin, evitando segredos e dados pessoais em argumentos de processo.
- Repetições de criação usam `clientRequestId` estável.
- WhatsApp outbound não existe na CLI nem na API.
- A fila de triagem externa usa claim atômico, lease renovável e conclusão validada pelo mesmo schema do domínio. O executor interno é desligado com `SUPPORT_AGENT_EXECUTOR=hermes`, evitando corrida entre agentes.

### Conhecimento e configuração

- Skills privadas, memória pessoal e ferramentas da organização pertencem ao perfil do Hermes e não entram no Git do Threadmark.
- O Threadmark distribuído mantém apenas regras universais do domínio e um contrato de capacidades descoberto por `threadmark capabilities --json`.
- Pessoas podem manter perfis/memórias separados no Hermes e compartilhar skills técnicas da organização.

### Superfícies preservadas

- conversas inbound e revisão das sugestões;
- separação manual de mensagens e assuntos;
- tickets, categorias, responsáveis e Kanban;
- usuários, permissões, auditoria e métricas operacionais.

### Retirada incremental

1. Publicar e validar a CLI headless, migrando primeiro as operações de ticket já usadas pelo Hermes.
2. Fazer a triagem automática produzir rascunhos revisáveis por meio do executor externo, usando `agent triage-status`, `triage-claim`, `triage-heartbeat` e `triage-complete`.
3. Migrar investigações, apps e automações agentic para o Hermes, mantendo no Threadmark apenas regras internas determinísticas.
4. Ocultar as telas antigas de IA, Ferramentas, Apps, Documentações e Threadmark AI depois da equivalência. Concluído sem apagar os registros legados.
5. Criar backup local e remover dados legados de documentação somente numa migração explícita e reversível.

## Consequências

- O frontend continua útil e não vira um requisito para agentes.
- O Hermes pode operar o mesmo backend local agora e uma API hospedada no futuro.
- Conhecimento específico de uma organização deixa de influenciar clones públicos do Threadmark.
- Confirmações acontecem no Hermes; a CLI ainda exige um sinal mecânico de aplicação e identidade auditável.
- Durante a transição, dados e endpoints legados permanecem para compatibilidade e recuperação, mas as superfícies antigas não aparecem na interface operacional.
