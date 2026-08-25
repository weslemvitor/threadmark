import type {
  AutomationNodeDefinition,
  AutomationNodeDto,
} from "./automation-types.js";
import { getAutomationConfigValue } from "./node-catalog.js";

const statusLabels: Record<string, string> = {
  new: "Novo",
  archived: "Arquivar ticket",
  blocked: "Aguardando interno",
  cancelled: "Cancelado",
  in_progress: "Em andamento",
  resolved: "Resolvido",
  triage: "Em revisão",
  waiting_customer: "Aguardando resposta",
};

const conditionValueOptions: Record<
  string,
  Array<{ label: string; value: string }>
> = {
  priority: [
    { label: "Baixa", value: "low" },
    { label: "Normal", value: "normal" },
    { label: "Alta", value: "high" },
    { label: "Urgente", value: "urgent" },
  ],
  status: [
    { label: "Novo", value: "new" },
    { label: "Em revisão", value: "triage" },
    { label: "Em andamento", value: "in_progress" },
    { label: "Aguardando resposta", value: "waiting_customer" },
    { label: "Aguardando interno", value: "blocked" },
    { label: "Resolvido", value: "resolved" },
    { label: "Cancelado", value: "cancelled" },
    { label: "Arquivado", value: "archived" },
  ],
};

export function automationConditionValueOptions(field: unknown) {
  return conditionValueOptions[String(field)] ?? [];
}

export function automationConditionValueLabel(
  field: unknown,
  value: unknown,
): string | null {
  const normalizedValue = String(value ?? "");
  if (!normalizedValue) return null;
  return automationConditionValueOptions(field)
    .find((option) => option.value === normalizedValue)?.label
    ?? normalizedValue;
}

function durationSummary(node: AutomationNodeDto): string | null {
  const durationMs = Number(getAutomationConfigValue(node.config, "durationMs"));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const configuredUnit = String(
    getAutomationConfigValue(node.config, "durationUnit") ?? "",
  );
  const units = [
    { key: "days", singular: "dia", plural: "dias", multiplier: 86_400_000 },
    { key: "hours", singular: "hora", plural: "horas", multiplier: 3_600_000 },
    { key: "minutes", singular: "minuto", plural: "minutos", multiplier: 60_000 },
  ];
  const unit = units.find((candidate) => candidate.key === configuredUnit)
    ?? units.find((candidate) => durationMs % candidate.multiplier === 0)
    ?? units[2]!;
  const amount = durationMs / unit.multiplier;
  const formatted = Number.isInteger(amount)
    ? String(amount)
    : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(amount);
  return `${formatted} ${amount === 1 ? unit.singular : unit.plural}`;
}

function optionLabel(
  definition: AutomationNodeDefinition,
  key: string,
  value: unknown,
): string | null {
  const field = definition.fields.find((candidate) => candidate.key === key);
  return field?.options?.find((option) => option.value === String(value))?.label ?? null;
}

export function automationNodeConfigurationSummary(
  node: AutomationNodeDto,
  definition: AutomationNodeDefinition,
): string | null {
  if (node.type === "trigger") {
    const eventType = getAutomationConfigValue(node.config, "eventType");
    return optionLabel(definition, "eventType", eventType);
  }
  if (node.type === "wait") return durationSummary(node);

  const actionId = String(getAutomationConfigValue(node.config, "actionId") ?? "");
  if (actionId === "change_status") {
    const status = String(getAutomationConfigValue(node.config, "input.status") ?? "");
    return statusLabels[status]
      ?? optionLabel(definition, "input.status", status)
      ?? null;
  }
  if (actionId === "change_priority") {
    const priority = getAutomationConfigValue(node.config, "input.priority");
    const label = optionLabel(definition, "input.priority", priority);
    return label ? `Prioridade: ${label}` : null;
  }
  if (actionId === "create_in_app_notification") {
    const recipient = getAutomationConfigValue(node.config, "input.recipient");
    const label = optionLabel(definition, "input.recipient", recipient);
    return label ? `Destino: ${label}` : null;
  }
  if (actionId === "assign_ticket_by_capacity") {
    const members = getAutomationConfigValue(node.config, "input.members");
    if (!Array.isArray(members) || members.length === 0) return null;
    const totalCapacity = members.reduce<number>((total, item) => {
      if (!item || Array.isArray(item) || typeof item !== "object") return total;
      return total + (typeof item.maxTickets === "number" ? item.maxTickets : 0);
    }, 0);
    return `${members.length} ${members.length === 1 ? "atendente" : "atendentes"} · ${totalCapacity} vagas`;
  }
  if (node.type === "condition") {
    const configuredField = getAutomationConfigValue(node.config, "field");
    const configuredOperator = getAutomationConfigValue(node.config, "operator");
    const field = optionLabel(
      definition,
      "field",
      configuredField,
    );
    const operator = optionLabel(
      definition,
      "operator",
      configuredOperator,
    );
    const value = configuredOperator === "exists" || configuredOperator === "not_exists"
      ? null
      : automationConditionValueLabel(
          configuredField,
          getAutomationConfigValue(node.config, "value"),
        );
    return [field, operator, value].filter(Boolean).join(" · ") || null;
  }
  return null;
}
