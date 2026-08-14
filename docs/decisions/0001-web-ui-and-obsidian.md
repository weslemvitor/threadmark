# ADR 0001: Web UI local como interface operacional

## Status

Aceita em 2026-07-16 e generalizada para a edição comunitária em 2026-07-18.

## Contexto

O sistema precisa exibir timeline de mensagens, anexos, tickets simultâneos, grupos, pessoas, registros personalizados, evidências, sugestões, auditoria e gráficos. Um vault Markdown é útil para conhecimento curado, mas não representa bem eventos de alto volume nem deve receber o histórico bruto de conversas.

## Decisão

- Usar uma Web UI local como interface operacional principal.
- Manter SQLite como fonte de verdade.
- Tratar Obsidian e outras pastas Markdown como integrações opcionais de conhecimento curado.
- Usar CLI/OpenTUI para ciclo de vida, status, ressincronização e diagnóstico.
- Nunca expor composer ou envio de mensagem na Web UI.

## Consequências

- A UI renderiza timelines, imagens, PDFs e gráficos sem converter cada evento em Markdown.
- O fluxo bruto não entra em pastas sincronizadas por padrão.
- Projeções para Markdown podem existir no futuro, mas não controlam a persistência principal.
- O produto continua local-first e acessível somente pelo computador do operador por padrão.
- Usuários podem escolher não configurar Obsidian sem perder recursos operacionais.
