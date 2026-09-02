import { searchInvestigationTools, type InvestigationToolSearchInput, type InvestigationToolSearchResult } from "./tool-discovery.js";
import type {
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "./types.js";

export interface ThreadmarkToolBridgeBroker {
  executeMany(
    requests: InvestigationToolRequest[],
  ): Promise<InvestigationToolResult[]>;
}

export interface ThreadmarkToolBridgeOptions {
  maxOperations?: number;
  maxSameOperation?: number;
  maxCodeSearchOperations?: number;
  onExecution?: (result: InvestigationToolResult) => void | Promise<void>;
}

const DEFAULT_MAX_OPERATIONS = 24;
const DEFAULT_MAX_SAME_OPERATION = 8;
const DEFAULT_MAX_CODE_SEARCH_OPERATIONS = 6;
const MAX_MODEL_TOOL_CONTENT_CHARS = 6_000;

export class ThreadmarkToolBridge {
  private readonly authorizedDescriptors: InvestigationToolDescriptor[];
  private readonly discoveredOperations = new Set<string>();
  private readonly observedRequestIds = new Set<string>();
  private readonly observedSemanticRequests = new Set<string>();
  private readonly operationCounts = new Map<string, number>();
  private readonly maxOperations: number;
  private readonly maxSameOperation: number;
  private readonly maxCodeSearchOperations: number;
  private readonly onExecution?: ThreadmarkToolBridgeOptions["onExecution"];
  private usedOperations = 0;

  constructor(
    private readonly broker: ThreadmarkToolBridgeBroker,
    authorizedDescriptors: readonly InvestigationToolDescriptor[],
    options: ThreadmarkToolBridgeOptions = {},
  ) {
    this.authorizedDescriptors = readonlyDescriptors(authorizedDescriptors);
    this.maxOperations = boundedLimit(options.maxOperations, DEFAULT_MAX_OPERATIONS);
    this.maxSameOperation = boundedLimit(options.maxSameOperation, DEFAULT_MAX_SAME_OPERATION);
    this.maxCodeSearchOperations = boundedLimit(
      options.maxCodeSearchOperations,
      DEFAULT_MAX_CODE_SEARCH_OPERATIONS,
    );
    this.onExecution = options.onExecution;
  }

  search(input: InvestigationToolSearchInput): InvestigationToolSearchResult {
    const result = searchInvestigationTools(this.authorizedDescriptors, {
      ...input,
      allowedEffects: ["read"],
    });
    for (const match of result.matches) {
      this.discoveredOperations.add(operationKey(match.toolId, match.operation));
    }
    return result;
  }

  async execute(request: InvestigationToolRequest): Promise<InvestigationToolResult> {
    const descriptor = this.authorizedDescriptors.find((item) => item.id === request.toolId);
    const operation = descriptor?.operations.find((item) => item.name === request.operation);
    const key = operationKey(request.toolId, request.operation);

    if (!descriptor || !operation || !this.discoveredOperations.has(key)) {
      return this.emit(policyError(
        request,
        descriptor?.name ?? request.toolId,
        "tool_not_discovered",
        "A operação não foi descoberta nesta sessão readonly.",
      ));
    }
    if (this.observedRequestIds.has(request.requestId)) {
      return this.emit(policyError(
        request,
        descriptor.name,
        "duplicate_request_id",
        "O requestId já foi usado nesta sessão.",
      ));
    }
    this.observedRequestIds.add(request.requestId);
    const semanticFingerprint = semanticRequestFingerprint(request);
    if (this.observedSemanticRequests.has(semanticFingerprint)) {
      return this.emit(policyError(
        request,
        descriptor.name,
        "duplicate_semantic_request",
        "Esta leitura equivalente já foi executada nesta sessão; reutilize a evidência anterior.",
      ));
    }
    this.observedSemanticRequests.add(semanticFingerprint);
    if (this.usedOperations >= this.maxOperations) {
      return this.emit(policyError(
        request,
        descriptor.name,
        "operation_budget_reached",
        "O orçamento de operações readonly desta sessão foi atingido.",
      ));
    }
    const currentCount = this.operationCounts.get(key) ?? 0;
    const operationLimit = descriptor.type === "codebase" && operation.name === "search_files"
      ? this.maxCodeSearchOperations
      : this.maxSameOperation;
    if (currentCount >= operationLimit) {
      return this.emit(policyError(
        request,
        descriptor.name,
        "operation_budget_reached",
        `O orçamento da operação ${operation.name} foi atingido.`,
      ));
    }

    this.usedOperations += 1;
    this.operationCounts.set(key, currentCount + 1);
    try {
      const [execution] = await this.broker.executeMany([request]);
      return this.emit(execution ?? policyError(
        request,
        descriptor.name,
        "empty_tool_result",
        "A ferramenta não devolveu um resultado auditável.",
      ));
    } catch {
      return this.emit(policyError(
        request,
        descriptor.name,
        "tool_execution_failed",
        "A execução readonly falhou antes de devolver um resultado auditável.",
        true,
      ));
    }
  }

  private async emit(result: InvestigationToolResult): Promise<InvestigationToolResult> {
    await this.onExecution?.(result);
    return result;
  }
}

export function boundToolResultForModel(
  result: InvestigationToolResult,
): InvestigationToolResult {
  if (result.content.length <= MAX_MODEL_TOOL_CONTENT_CHARS) return result;
  const headLength = 4_500;
  const tailLength = 1_500;
  const omitted = result.content.length - headLength - tailLength;
  return {
    ...result,
    content:
      `${result.content.slice(0, headLength)}\n\n[${omitted} caracteres omitidos]\n\n${result.content.slice(-tailLength)}`,
  };
}

function readonlyDescriptors(
  descriptors: readonly InvestigationToolDescriptor[],
): InvestigationToolDescriptor[] {
  return descriptors.flatMap((descriptor) => {
    const operations = descriptor.operations.filter(
      (operation) => (operation.effect ?? "read") === "read",
    );
    return operations.length ? [{ ...descriptor, operations }] : [];
  });
}

function operationKey(toolId: string, operation: string): string {
  return `${toolId}\u0000${operation}`;
}

const SEMANTICALLY_IRRELEVANT_ARGUMENTS = new Set([
  "caseSensitive",
  "limit",
  "maxFiles",
  "maxLines",
  "maxResults",
  "maxRows",
  "timeoutMs",
]);

function semanticRequestFingerprint(
  request: Pick<InvestigationToolRequest, "toolId" | "operation" | "argumentsJson">,
): string {
  try {
    return `${operationKey(request.toolId, request.operation)}\u0000${stableJson(
      stripSemanticNoise(JSON.parse(request.argumentsJson) as unknown),
    )}`;
  } catch {
    return `${operationKey(request.toolId, request.operation)}\u0000${request.argumentsJson.trim()}`;
  }
}

function stripSemanticNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSemanticNoise);
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")
      : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SEMANTICALLY_IRRELEVANT_ARGUMENTS.has(key))
      .map(([key, item]) => [key, stripSemanticNoise(item)]),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return fallback;
  return Math.min(value as number, 100);
}

function policyError(
  request: InvestigationToolRequest,
  toolName: string,
  code: string,
  summary: string,
  retryable = false,
): InvestigationToolResult {
  return {
    ...request,
    toolName,
    status: "error",
    error: {
      code,
      category: code.includes("budget") ? "authorization" : "invalid_arguments",
      retryable,
    },
    summary,
    content: summary,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}
