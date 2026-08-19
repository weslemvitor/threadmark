import {
  AUTOMATION_NODE_TYPES,
  type AutomationComparisonOperator,
  type AutomationEdge,
  type AutomationFilter,
  type AutomationNode,
  type AutomationRetryPolicy,
  type AutomationWorkflowDefinition,
} from "./types.js";

const OPERATORS = new Set<AutomationComparisonOperator>([
  "equals",
  "not_equals",
  "contains",
  "exists",
  "not_exists",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export class AutomationValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Fluxo inválido: ${issues.join("; ")}`);
    this.name = "AutomationValidationError";
  }
}

export function validateWorkflowDefinition(
  definition: AutomationWorkflowDefinition,
): AutomationWorkflowDefinition {
  const issues: string[] = [];
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    throw new AutomationValidationError(["nodes e edges são obrigatórios"]);
  }
  if (definition.nodes.length === 0) issues.push("adicione ao menos um nó");
  if (definition.nodes.length > 100) issues.push("o limite é de 100 nós");
  if (definition.edges.length > 200) issues.push("o limite é de 200 conexões");

  const nodeIds = new Set<string>();
  for (const node of definition.nodes) validateNode(node, nodeIds, issues);
  validateEdges(definition.edges, nodeIds, issues);

  const triggers = definition.nodes.filter((node) => node.type === "trigger");
  if (triggers.length !== 1) issues.push("o fluxo deve ter exatamente um gatilho");
  const actions = definition.nodes.filter(
    (node) => node.type === "internal_action" || node.type === "app_action",
  );
  if (actions.length === 0) issues.push("o fluxo deve ter ao menos uma ação");

  if (nodeIds.size === definition.nodes.length) {
    validateGraph(definition, triggers[0]?.id, issues);
  }
  assertJsonSerializable(definition, issues);
  if (issues.length) throw new AutomationValidationError(issues);
  return definition;
}

/**
 * Drafts may be incomplete while the user is arranging the canvas. They still
 * need bounded, serializable and structurally recognizable data. Activation
 * always calls the strict validator above.
 */
export function validateWorkflowDraftDefinition(
  definition: AutomationWorkflowDefinition,
): AutomationWorkflowDefinition {
  const issues: string[] = [];
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    throw new AutomationValidationError(["nodes e edges são obrigatórios"]);
  }
  if (definition.nodes.length > 100) issues.push("o limite é de 100 nós");
  if (definition.edges.length > 200) issues.push("o limite é de 200 conexões");
  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (!IDENTIFIER_PATTERN.test(node.id)) issues.push(`id de nó inválido: ${node.id}`);
    if (nodeIds.has(node.id)) issues.push(`id de nó duplicado: ${node.id}`);
    nodeIds.add(node.id);
    if (!AUTOMATION_NODE_TYPES.includes(node.type)) {
      issues.push(`tipo de nó não suportado em ${node.id}`);
    }
    if (!isRecord(node.config)) issues.push(`configuração ausente em ${node.id}`);
  }
  validateEdges(definition.edges, nodeIds, issues);
  assertJsonSerializable(definition, issues);
  if (issues.length) throw new AutomationValidationError(issues);
  return definition;
}

function validateNode(
  node: AutomationNode,
  nodeIds: Set<string>,
  issues: string[],
): void {
  if (!IDENTIFIER_PATTERN.test(node.id)) issues.push(`id de nó inválido: ${node.id}`);
  if (nodeIds.has(node.id)) issues.push(`id de nó duplicado: ${node.id}`);
  nodeIds.add(node.id);
  if (!AUTOMATION_NODE_TYPES.includes(node.type)) {
    issues.push(`tipo de nó não suportado em ${node.id}`);
    return;
  }
  if (!isRecord(node.config)) {
    issues.push(`configuração ausente em ${node.id}`);
    return;
  }

  switch (node.type) {
    case "trigger":
      if (!isNonEmptyString(node.config.eventType)) {
        issues.push(`eventType obrigatório em ${node.id}`);
      }
      validateFilters(node.config.filters ?? [], node.id, issues);
      break;
    case "condition":
      validateFilter(node.config, node.id, issues);
      break;
    case "wait":
      if (
        !Number.isInteger(node.config.durationMs) ||
        node.config.durationMs < 0 ||
        node.config.durationMs > 31_536_000_000
      ) {
        issues.push(`durationMs inválido em ${node.id}`);
      }
      break;
    case "approval":
      if (
        node.config.instructions !== undefined &&
        typeof node.config.instructions !== "string"
      ) {
        issues.push(`instructions inválido em ${node.id}`);
      }
      break;
    case "internal_action":
      if (!isNonEmptyString(node.config.actionId)) {
        issues.push(`actionId obrigatório em ${node.id}`);
      }
      if (
        node.config.actionId === "create_in_app_notification" ||
        node.config.actionId === "send_push_notification"
      ) {
        validateNotificationAction(node.config.input, node.id, issues);
      }
      validateRetry(node.config.retry, node.id, issues);
      break;
    case "app_action":
      if (!isNonEmptyString(node.config.appId)) {
        issues.push(`appId obrigatório em ${node.id}`);
      }
      if (!isNonEmptyString(node.config.actionId)) {
        issues.push(`actionId obrigatório em ${node.id}`);
      }
      if (isWhatsappAction(node.config.appId, node.config.actionId)) {
        issues.push(`ações outbound do WhatsApp são proibidas em ${node.id}`);
      }
      validateRetry(node.config.retry, node.id, issues);
      break;
  }
}

function validateNotificationAction(
  input: unknown,
  nodeId: string,
  issues: string[],
): void {
  if (!isRecord(input)) {
    issues.push(`configuração da notificação ausente em ${nodeId}`);
    return;
  }
  const recipient = input.recipient;
  const recipientValue = String(recipient);
  if (
    recipientValue !== "assignee" &&
    recipientValue !== "all" &&
    !recipientValue.startsWith("user:")
  ) {
    issues.push(`destinatário da notificação inválido em ${nodeId}`);
  }
  if (recipientValue.startsWith("user:") && !recipientValue.slice(5).trim()) {
    issues.push(`usuário da notificação obrigatório em ${nodeId}`);
  }
  if (!isNonEmptyString(input.title)) {
    issues.push(`título da notificação obrigatório em ${nodeId}`);
  }
  if (!isNonEmptyString(input.body)) {
    issues.push(`mensagem da notificação obrigatória em ${nodeId}`);
  }
}

function validateEdges(
  edges: AutomationEdge[],
  nodeIds: Set<string>,
  issues: string[],
): void {
  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  for (const edge of edges) {
    if (!IDENTIFIER_PATTERN.test(edge.id)) issues.push(`id de conexão inválido: ${edge.id}`);
    if (edgeIds.has(edge.id)) issues.push(`id de conexão duplicado: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) issues.push(`origem inexistente em ${edge.id}`);
    if (!nodeIds.has(edge.target)) issues.push(`destino inexistente em ${edge.id}`);
    if (edge.source === edge.target) issues.push(`auto conexão proibida em ${edge.id}`);
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.sourceHandle ?? ""}`;
    if (connections.has(key)) issues.push(`conexão duplicada em ${edge.id}`);
    connections.add(key);
  }
}

function validateGraph(
  definition: AutomationWorkflowDefinition,
  triggerId: string | undefined,
  issues: string[],
): void {
  const outgoing = new Map<string, AutomationEdge[]>();
  const incomingCount = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (!incomingCount.has(edge.target) || !incomingCount.has(edge.source)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  if (triggerId && (incomingCount.get(triggerId) ?? 0) > 0) {
    issues.push("o gatilho não pode possuir conexões de entrada");
  }
  for (const [nodeId, count] of incomingCount) {
    if (nodeId !== triggerId && count > 1) {
      issues.push(`junções ainda não são suportadas no nó ${nodeId}`);
    }
  }
  validateBranchHandles(definition.nodes, outgoing, issues);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      issues.push("o fluxo não pode conter ciclos");
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) visit(edge.target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  if (triggerId) visit(triggerId);
  for (const node of definition.nodes) {
    if (triggerId && !visited.has(node.id)) issues.push(`nó inalcançável: ${node.id}`);
  }
}

function validateBranchHandles(
  nodes: AutomationNode[],
  outgoing: Map<string, AutomationEdge[]>,
  issues: string[],
): void {
  for (const node of nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.type === "condition") {
      validateAllowedHandles(node.id, edges, ["true", "false"], issues);
    } else if (node.type === "approval") {
      validateAllowedHandles(node.id, edges, ["approved", "rejected"], issues);
    }
  }
}

function validateAllowedHandles(
  nodeId: string,
  edges: AutomationEdge[],
  allowed: string[],
  issues: string[],
): void {
  const handles = new Set<string>();
  for (const edge of edges) {
    if (!edge.sourceHandle || !allowed.includes(edge.sourceHandle)) {
      issues.push(`saída inválida em ${nodeId}; use ${allowed.join(" ou ")}`);
      continue;
    }
    if (handles.has(edge.sourceHandle)) {
      issues.push(`somente uma saída ${edge.sourceHandle} é permitida em ${nodeId}`);
    }
    handles.add(edge.sourceHandle);
  }
}

function validateFilters(filters: AutomationFilter[], nodeId: string, issues: string[]): void {
  if (!Array.isArray(filters)) {
    issues.push(`filters inválido em ${nodeId}`);
    return;
  }
  for (const filter of filters) validateFilter(filter, nodeId, issues);
}

function validateFilter(filter: AutomationFilter, nodeId: string, issues: string[]): void {
  if (!isRecord(filter) || !isNonEmptyString(filter.field)) {
    issues.push(`field obrigatório em ${nodeId}`);
  }
  if (!isRecord(filter) || !OPERATORS.has(filter.operator)) {
    issues.push(`operator inválido em ${nodeId}`);
  }
}

function validateRetry(
  retry: AutomationRetryPolicy | undefined,
  nodeId: string,
  issues: string[],
): void {
  if (retry === undefined) return;
  if (
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    retry.maxAttempts > 5
  ) {
    issues.push(`maxAttempts deve estar entre 1 e 5 em ${nodeId}`);
  }
  if (!Number.isInteger(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 86_400_000) {
    issues.push(`delayMs inválido em ${nodeId}`);
  }
}

function isWhatsappAction(appId: string, actionId: string): boolean {
  return [appId, actionId].some((value) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "").includes("whatsapp"),
  );
}

function assertJsonSerializable(value: unknown, issues: string[]): void {
  try {
    JSON.stringify(value);
  } catch {
    issues.push("a definição precisa ser serializável em JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, root);
}

export function matchesFilter(root: unknown, filter: AutomationFilter): boolean {
  const actual = readPath(root, filter.field);
  switch (filter.operator) {
    case "equals":
      return actual === filter.value;
    case "not_equals":
      return actual !== filter.value;
    case "contains":
      return Array.isArray(actual)
        ? actual.includes(filter.value)
        : typeof actual === "string" && typeof filter.value === "string"
          ? actual.includes(filter.value)
          : false;
    case "exists":
      return filter.value === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "greater_than":
      return comparable(actual, filter.value, (left, right) => left > right);
    case "greater_than_or_equal":
      return comparable(actual, filter.value, (left, right) => left >= right);
    case "less_than":
      return comparable(actual, filter.value, (left, right) => left < right);
    case "less_than_or_equal":
      return comparable(actual, filter.value, (left, right) => left <= right);
  }
}

function comparable(
  left: unknown,
  right: unknown,
  compare: (left: number, right: number) => boolean,
): boolean {
  return typeof left === "number" && typeof right === "number" && compare(left, right);
}
