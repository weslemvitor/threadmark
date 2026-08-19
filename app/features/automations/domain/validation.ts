import {
  automationNodeCatalogId,
  automationNodeDefinition,
  getAutomationConfigValue,
} from "./node-catalog.js";
import type {
  AutomationDefinition,
  AutomationNodeDefinition,
  AutomationValidationIssue,
} from "./automation-types.js";

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function cycleNodes(definition: AutomationDefinition): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const node of definition.nodes) adjacency.set(node.id, []);
  for (const edge of definition.edges) adjacency.get(edge.source)?.push(edge.target);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();

  function visit(nodeId: string, path: string[]) {
    if (visiting.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId);
      for (const id of path.slice(cycleStart)) cycles.add(id);
      cycles.add(nodeId);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) visit(next, [...path, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const node of definition.nodes) visit(node.id, []);
  return cycles;
}

export function validateAutomation(
  definition: AutomationDefinition,
  catalog: AutomationNodeDefinition[],
): AutomationValidationIssue[] {
  const issues: AutomationValidationIssue[] = [];
  const triggers = definition.nodes.filter(
    (node) => automationNodeDefinition(automationNodeCatalogId(node), catalog)?.category === "trigger",
  );

  if (!definition.nodes.length) {
    issues.push({
      id: "empty-flow",
      nodeId: null,
      severity: "error",
      message: "Adicione um gatilho e pelo menos uma ação.",
    });
    return issues;
  }

  if (triggers.length !== 1) {
    issues.push({
      id: "trigger-count",
      nodeId: null,
      severity: "error",
      message:
        triggers.length === 0
          ? "O fluxo precisa de um gatilho."
          : "Mantenha apenas um gatilho por fluxo.",
    });
  }

  if (!definition.nodes.some((node) => node.type === "internal_action" || node.type === "app_action")) {
    issues.push({
      id: "action-count",
      nodeId: null,
      severity: "error",
      message: "O fluxo precisa de pelo menos uma ação interna ou de app conectado.",
    });
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of definition.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  for (const node of definition.nodes) {
    const nodeDefinition = automationNodeDefinition(automationNodeCatalogId(node), catalog);
    if (!nodeDefinition) {
      issues.push({
        id: `unknown-${node.id}`,
        nodeId: node.id,
        severity: "error",
        message: "Este tipo de nó não está mais disponível.",
      });
      continue;
    }

    if (nodeDefinition.category !== "trigger" && !incoming.get(node.id)) {
      issues.push({
        id: `incoming-${node.id}`,
        nodeId: node.id,
        severity: "error",
        message: `${nodeDefinition.label} precisa estar conectado a uma etapa anterior.`,
      });
    }
    if ((incoming.get(node.id) ?? 0) > 1) {
      issues.push({
        id: `join-${node.id}`,
        nodeId: node.id,
        severity: "error",
        message: "Junções de caminhos ainda não são suportadas neste nó.",
      });
    }
    if (!nodeDefinition.terminal && !outgoing.get(node.id)) {
      issues.push({
        id: `outgoing-${node.id}`,
        nodeId: node.id,
        severity: "warning",
        message: `${nodeDefinition.label} encerra o fluxo neste ponto.`,
      });
    }
    if (nodeDefinition.category === "connected_app" && nodeDefinition.connected === false) {
      issues.push({
        id: `connection-${node.id}`,
        nodeId: node.id,
        severity: "error",
        message: `Conecte ${nodeDefinition.connectionLabel ?? "este app"} antes de ativar.`,
      });
    }

    for (const field of nodeDefinition.fields) {
      const value = getAutomationConfigValue(node.config, field.key);
      const conditionOperator = node.type === "condition"
        ? getAutomationConfigValue(node.config, "operator")
        : null;
      const valueIsNotApplicable =
        field.key === "value" &&
        (conditionOperator === "exists" || conditionOperator === "not_exists");
      if (field.required && !valueIsNotApplicable && isEmpty(value)) {
        issues.push({
          id: `field-${node.id}-${field.key}`,
          nodeId: node.id,
          severity: "error",
          message: `Preencha “${field.label}” em ${nodeDefinition.label}.`,
        });
      }
      if (field.type === "number" && typeof value === "number") {
        const displayValue = value / (field.storageMultiplier ?? 1);
        if (field.min !== undefined && displayValue < field.min) {
          issues.push({
            id: `min-${node.id}-${field.key}`,
            nodeId: node.id,
            severity: "error",
            message: `${field.label} deve ser no mínimo ${field.min}.`,
          });
        }
        if (field.max !== undefined && displayValue > field.max) {
          issues.push({
            id: `max-${node.id}-${field.key}`,
            nodeId: node.id,
            severity: "error",
            message: `${field.label} deve ser no máximo ${field.max}.`,
          });
        }
      }
      if (field.type === "duration" && typeof value === "number") {
        const configuredUnit = getAutomationConfigValue(
          node.config,
          field.durationUnitKey ?? "durationUnit",
        );
        const unit = field.durationUnits?.find(
          (candidate) => candidate.value === configuredUnit,
        ) ?? field.durationUnits?.[0];
        const displayValue = unit ? value / unit.multiplier : value;
        if (field.min !== undefined && displayValue < field.min) {
          issues.push({
            id: `min-${node.id}-${field.key}`,
            nodeId: node.id,
            severity: "error",
            message: `${field.label} deve ser no mínimo ${field.min}.`,
          });
        }
        if (value > 31_536_000_000) {
          issues.push({
            id: `max-${node.id}-${field.key}`,
            nodeId: node.id,
            severity: "error",
            message: `${field.label} deve ser no máximo 365 dias.`,
          });
        }
      }
    }
  }

  for (const node of definition.nodes) {
    if (node.type !== "condition" && node.type !== "approval") continue;
    const allowed = node.type === "condition" ? ["true", "false"] : ["approved", "rejected"];
    const handles = definition.edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => edge.sourceHandle ?? "");
    if (handles.some((handle) => !allowed.includes(handle))) {
      issues.push({
        id: `branch-${node.id}`,
        nodeId: node.id,
        severity: "error",
        message: `Conecte as saídas ${allowed.join(" e ")} separadamente.`,
      });
    }
  }

  for (const nodeId of cycleNodes(definition)) {
    issues.push({
      id: `cycle-${nodeId}`,
      nodeId,
      severity: "error",
      message: "Remova o ciclo antes de ativar o fluxo.",
    });
  }

  return issues;
}
