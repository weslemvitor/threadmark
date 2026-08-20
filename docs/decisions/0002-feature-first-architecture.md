# ADR 0002: Organização incremental por features e domínios

## Status

Aceita em 2026-07-23. A migração é incremental e deve preservar comportamento,
contratos, persistência e integrações em cada etapa.

## Contexto

O Threadmark cresceu com três superfícies distintas:

- Web UI local em `app/`;
- API, domínio, integrações e runtime em `server/`;
- contratos comuns em `shared/`.

Essa separação de alto nível continua correta. O problema está principalmente
na organização interna:

- componentes e regras do frontend estão achatados em `app/components` e
  `app/lib`;
- `app/support-app.tsx` coordena quase todas as features;
- `server/domain/support-store.ts` e `server/index.ts` concentram múltiplos
  domínios;
- `shared/contracts.ts` reúne contratos de todas as áreas;
- imports relativos longos tornam movimentações frágeis.

Aplicar uma única árvore de pastas a todas as superfícies criaria abstrações
artificiais. A estrutura precisa respeitar as responsabilidades diferentes de
frontend, backend e contratos compartilhados.

## Decisão

### Frontend

Funcionalidades com múltiplos arquivos relacionados ficam em
`app/features/<feature>/`. Cada feature expõe uma API pública curta por
`index.ts` e cria apenas as subpastas que realmente usar:

```text
app/
├── components/
│   ├── ui/       # primitives visuais genéricas
│   ├── layout/   # shell e estrutura visual
│   └── shared/   # componentes usados por múltiplas features
├── features/
│   └── tickets/
│       ├── components/
│       ├── domain/
│       └── index.ts
├── lib/          # infraestrutura do frontend, não regras de uma feature
└── support-app.tsx
```

Regras:

- componentes exclusivos pertencem à feature;
- regras puras e tipos específicos ficam no domínio da feature;
- `app/lib` fica reservado para infraestrutura transversal;
- outras features consomem preferencialmente o `index.ts` público;
- uma feature não importa arquivos internos de outra feature;
- componentes genéricos não conhecem regras de uma feature.

Não serão criadas pastas vazias de `hooks`, `services`, `schemas` ou `types`.
Elas surgem somente quando houver responsabilidade concreta a separar.

### Backend

O backend será migrado gradualmente por domínio, sem copiar literalmente a
estrutura do frontend:

```text
server/
├── modules/          # tickets, conversations, directory...
├── integrations/     # WhatsApp, IA e ferramentas externas
├── infrastructure/   # SQLite e mídia
├── runtime/          # ciclo de vida da aplicação local
└── index.ts           # composition root temporário
```

As pastas técnicas existentes continuam válidas enquanto a extração de cada
domínio não estiver concluída. Métodos serão retirados de
`SupportStore` somente junto com seus testes e sem mudar SQL ou contratos.

### Código compartilhado

`shared/contracts.ts` continuará sendo a entrada compatível durante a migração.
Os contratos serão separados por domínio atrás desse barrel antes de qualquer
consumidor mudar de import.

## Limites de dependência

```text
app feature -> app shared/platform -> shared contracts
server module -> server infrastructure/integration -> shared contracts
shared contracts -> nenhuma superfície da aplicação
```

Dependências no sentido contrário não são permitidas. Exceções temporárias
devem ser explícitas e removidas na mesma fase que concluir a migração afetada.

## Plano incremental

1. Criar a fundação feature-first e migrar Tickets e Conversas.
2. Classificar componentes genéricos entre `ui`, `layout` e `shared`.
3. Migrar Tickets e Conversas, mantendo a UI e os contratos atuais.
4. Migrar Diretório, Categorias, Dashboard, Kanban e Configurações.
5. Dividir o cliente de API por feature atrás de uma fachada compatível.
6. Extrair rotas e persistência do backend por domínio.
7. Dividir contratos compartilhados atrás do barrel existente.
8. Reduzir o `support-app.tsx` a composição, navegação e estado transversal.

Cada fase deve terminar com testes focados, typecheck, lint e build. Mudanças de
comportamento e a adoção do shadcn/ui ficam fora desta decisão.

## Consequências

- novos contribuidores encontram código pelo domínio do produto;
- movimentações futuras ficam menores e validáveis;
- a migração pode coexistir temporariamente com pastas legadas;
- alguns barrels e fachadas serão mantidos para compatibilidade;
- arquivos gigantes do backend exigirão fases próprias, não uma movimentação
  mecânica única.
