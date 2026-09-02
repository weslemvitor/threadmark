import type { InvestigationToolDescriptor } from "./types.js";

type InvestigationToolOperation = InvestigationToolDescriptor["operations"][number];
type InvestigationToolEffect = NonNullable<InvestigationToolOperation["effect"]>;

export interface InvestigationToolSearchInput {
  query: string;
  /** Maximum number of operation contracts returned across all tools. */
  limit?: number;
  /** Discovery is readonly by default. Writes must be opted into explicitly. */
  allowedEffects?: readonly InvestigationToolEffect[];
}

export interface InvestigationToolSearchMatch {
  toolId: string;
  toolName: string;
  toolType: InvestigationToolDescriptor["type"];
  operation: string;
  score: number;
  matchedTerms: string[];
}

export interface InvestigationToolSearchResult {
  query: string;
  descriptors: InvestigationToolDescriptor[];
  matches: InvestigationToolSearchMatch[];
  sourceCatalogCharacters: number;
  selectedCatalogCharacters: number;
}

const STOP_WORDS = new Set([
  "a",
  "as",
  "com",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "nao",
  "no",
  "nos",
  "o",
  "os",
  "para",
  "por",
  "que",
  "the",
  "to",
  "um",
  "uma",
  "with",
]);

const DOMAIN_HINTS: Array<{
  queryTerms: readonly string[];
  types: readonly InvestigationToolDescriptor["type"][];
  operationWeights: Readonly<Record<string, number>>;
}> = [
  {
    queryTerms: ["codigo", "code", "fonte", "regra", "implementacao", "arquivo"],
    types: ["codebase"],
    operationWeights: { search_files: 8, read_files: 5, list_files: 2 },
  },
  {
    queryTerms: ["banco", "database", "sql", "tabela", "tabelas", "registro", "registros", "pedido", "pedidos"],
    types: ["postgres_readonly", "clickhouse_readonly"],
    operationWeights: { query_readonly: 9, describe_schema: 4 },
  },
  {
    queryTerms: ["log", "logs", "aws", "cloudwatch", "metrica", "erro", "lambda"],
    types: ["aws_cloudwatch"],
    operationWeights: { query_logs: 9, read_metrics: 3 },
  },
  {
    queryTerms: ["vercel", "deploy", "deployment", "frontend"],
    types: ["vercel"],
    operationWeights: { read_logs: 8, read_deployments: 4 },
  },
  {
    queryTerms: ["conhecimento", "knowledge", "documentacao", "documento", "nota"],
    types: ["knowledge"],
    operationWeights: { search_files: 8, read_files: 5, list_files: 2 },
  },
  {
    queryTerms: ["skill", "metodologia", "procedimento", "investigacao"],
    types: ["debugger_skill"],
    operationWeights: { read_skill: 5 },
  },
];

const OPERATION_HINTS: Array<{
  queryTerms: readonly string[];
  operations: readonly string[];
}> = [
  { queryTerms: ["buscar", "busca", "search", "procurar", "encontrar"], operations: ["search_files"] },
  { queryTerms: ["ler", "leitura", "read", "abrir"], operations: ["read_files", "read_skill"] },
  { queryTerms: ["listar", "lista", "list"], operations: ["list_files"] },
  { queryTerms: ["consultar", "consulta", "query", "sql"], operations: ["query_readonly", "query_logs"] },
];

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function terms(value: string): string[] {
  return [...new Set(normalize(value).split(/\s+/).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

function operationEffect(operation: InvestigationToolOperation): InvestigationToolEffect {
  return operation.effect ?? "read";
}

function operationScore(
  descriptor: InvestigationToolDescriptor,
  operation: InvestigationToolOperation,
  query: string,
  queryTerms: readonly string[],
): { score: number; matchedTerms: string[] } {
  const toolText = normalize([
    descriptor.name,
    descriptor.type,
    descriptor.description ?? "",
    descriptor.scope,
  ].join(" "));
  const operationText = normalize([
    operation.name,
    operation.description,
    operation.constraints?.join(" ") ?? "",
  ].join(" "));
  const matchedTerms = queryTerms.filter((term) => toolText.includes(term) || operationText.includes(term));
  let score = 0;

  for (const term of matchedTerms) {
    if (operationText.includes(term)) score += 8;
    if (toolText.includes(term)) score += 4;
  }

  const normalizedQuery = normalize(query);
  if (normalizedQuery.length >= 4 && operationText.includes(normalizedQuery)) score += 20;

  for (const hint of DOMAIN_HINTS) {
    const activated = hint.queryTerms.some((term) => queryTerms.includes(term));
    if (!activated) continue;
    if (hint.types.includes(descriptor.type)) score += 12;
    score += hint.operationWeights[operation.name] ?? 0;
  }

  for (const hint of OPERATION_HINTS) {
    if (
      hint.queryTerms.some((term) => queryTerms.includes(term)) &&
      hint.operations.includes(operation.name)
    ) {
      score += 10;
    }
  }

  return { score, matchedTerms };
}

/**
 * Searches only the descriptors supplied by the trusted coordinator.
 *
 * This function never broadens authorization or executes a tool. Its output is
 * a compact set of contracts that can be handed back to the model while the
 * existing broker remains the only execution boundary.
 */
export function searchInvestigationTools(
  authorizedDescriptors: readonly InvestigationToolDescriptor[],
  input: InvestigationToolSearchInput,
): InvestigationToolSearchResult {
  const query = input.query.trim();
  const queryTerms = terms(query);
  const limit = Math.max(1, Math.min(input.limit ?? 6, 20));
  const allowedEffects = new Set(input.allowedEffects ?? ["read"]);

  const ranked = authorizedDescriptors.flatMap((descriptor) =>
    descriptor.operations
      .filter((operation) => allowedEffects.has(operationEffect(operation)))
      .map((operation) => {
        const ranking = operationScore(descriptor, operation, query, queryTerms);
        return { descriptor, operation, ...ranking };
      })
      .filter((item) => item.score > 0)
  ).sort((left, right) =>
    right.score - left.score ||
    left.descriptor.name.localeCompare(right.descriptor.name, "pt-BR") ||
    left.operation.name.localeCompare(right.operation.name, "en")
  ).slice(0, limit);

  const grouped = new Map<string, InvestigationToolDescriptor>();
  for (const item of ranked) {
    const selected = grouped.get(item.descriptor.id);
    if (selected) {
      selected.operations.push(item.operation);
      continue;
    }
    grouped.set(item.descriptor.id, {
      ...item.descriptor,
      scope: modelSafeScope(item.descriptor),
      operations: [item.operation],
    });
  }

  const descriptors = [...grouped.values()];
  return {
    query,
    descriptors,
    matches: ranked.map((item) => ({
      toolId: item.descriptor.id,
      toolName: item.descriptor.name,
      toolType: item.descriptor.type,
      operation: item.operation.name,
      score: item.score,
      matchedTerms: item.matchedTerms,
    })),
    sourceCatalogCharacters: JSON.stringify(authorizedDescriptors).length,
    selectedCatalogCharacters: JSON.stringify(descriptors).length,
  };
}

function modelSafeScope(descriptor: InvestigationToolDescriptor): string {
  switch (descriptor.type) {
    case "codebase":
      return "Raiz de código readonly autorizada pelo Threadmark.";
    case "knowledge":
      return "Base de conhecimento readonly autorizada pelo Threadmark.";
    case "debugger_skill":
      return "Metodologia local readonly autorizada pelo Threadmark.";
    case "postgres_readonly":
      return "PostgreSQL readonly autorizado pelo Threadmark.";
    case "clickhouse_readonly":
      return "ClickHouse readonly autorizado pelo Threadmark.";
    default:
      return descriptor.scope;
  }
}
