import type {
  AutomationNodeCategory,
  AutomationNodeConfig,
  AutomationNodeConfigValue,
  AutomationNodeDefinition,
  ConnectedAppSummary,
} from "./automation-types.js";

export const automationCategoryLabels: Record<AutomationNodeCategory, string> = {
  trigger: "Gatilhos do Threadmark",
  flow_control: "Controle de fluxo",
  internal_action: "Ações internas",
  connected_app: "Apps conectados",
};

export const automationCategoryDescriptions: Record<AutomationNodeCategory, string> = {
  trigger: "Eventos internos que iniciam uma execução.",
  flow_control: "Espere, decida ou solicite confirmação humana.",
  internal_action: "Organize o ticket sem sair do Threadmark.",
  connected_app: "Execute ações em integrações autorizadas.",
};

export const defaultAutomationNodeCatalog: AutomationNodeDefinition[] = [
  {
    id: "trigger.ticket_created",
    nodeType: "trigger",
    category: "trigger",
    label: "Ticket criado",
    description: "Inicia quando uma nova demanda é confirmada.",
    icon: "ticket",
    accent: "violet",
    fields: [],
    baseConfig: { eventType: "ticket_created" },
  },
  {
    id: "trigger.priority_changed",
    nodeType: "trigger",
    category: "trigger",
    label: "Prioridade alterada",
    description: "Inicia quando a urgência de um ticket muda.",
    icon: "flag",
    accent: "violet",
    fields: [],
    baseConfig: { eventType: "priority_changed" },
  },
  {
    id: "trigger.status_changed",
    nodeType: "trigger",
    category: "trigger",
    label: "Status alterado",
    description: "Inicia quando o ticket muda de etapa no atendimento.",
    icon: "refresh-cw",
    accent: "blue",
    fields: [],
    baseConfig: { eventType: "status_changed" },
  },
  {
    id: "trigger.ticket_resolved",
    nodeType: "trigger",
    category: "trigger",
    label: "Ticket resolvido",
    description: "Inicia após a resolução ser registrada.",
    icon: "circle-check",
    accent: "violet",
    fields: [],
    baseConfig: { eventType: "ticket_resolved" },
  },
  {
    id: "flow.wait",
    nodeType: "wait",
    category: "flow_control",
    label: "Esperar",
    description: "Continua a execução depois de um intervalo persistente.",
    icon: "clock",
    accent: "amber",
    fields: [
      {
        key: "durationMs",
        label: "Tempo de espera",
        type: "duration",
        required: true,
        min: 1,
        defaultValue: 900_000,
        description: "O intervalo pode ser configurado em minutos, horas ou dias, até o limite de 365 dias.",
        durationUnitKey: "durationUnit",
        durationUnits: [
          { label: "Minutos", value: "minutes", multiplier: 60_000 },
          { label: "Horas", value: "hours", multiplier: 3_600_000 },
          { label: "Dias", value: "days", multiplier: 86_400_000 },
        ],
      },
    ],
    baseConfig: { durationUnit: "minutes" },
  },
  {
    id: "flow.condition",
    nodeType: "condition",
    category: "flow_control",
    label: "Condição",
    description: "Divide o fluxo com base em um campo do ticket.",
    icon: "split",
    accent: "blue",
    fields: [
      {
        key: "field",
        label: "Campo",
        type: "select",
        required: true,
        defaultValue: "priority",
        options: [
          { label: "Prioridade", value: "priority" },
          { label: "Status", value: "status" },
          { label: "Categoria", value: "category" },
          { label: "Responsável", value: "assignee" },
        ],
      },
      {
        key: "operator",
        label: "Operador",
        type: "select",
        required: true,
        defaultValue: "equals",
        options: [
          { label: "É igual a", value: "equals" },
          { label: "É diferente de", value: "not_equals" },
          { label: "Contém", value: "contains" },
          { label: "Está preenchido", value: "exists" },
          { label: "Está vazio", value: "not_exists" },
        ],
      },
      {
        key: "value",
        label: "Valor",
        type: "text",
        required: true,
        placeholder: "Ex.: urgente",
      },
    ],
  },
  {
    id: "flow.approval",
    nodeType: "approval",
    category: "flow_control",
    label: "Aprovação humana",
    description: "Pausa até uma pessoa autorizar a próxima ação.",
    icon: "user-check",
    accent: "emerald",
    fields: [
      {
        key: "instructions",
        label: "Mensagem da aprovação",
        type: "textarea",
        required: true,
        defaultValue: "Revise os dados antes de continuar este fluxo.",
      },
    ],
  },
  {
    id: "internal.assign",
    nodeType: "internal_action",
    category: "internal_action",
    label: "Atribuir responsável",
    description: "Direciona o ticket para uma pessoa da equipe.",
    icon: "user-round-check",
    accent: "emerald",
    fields: [
      {
        key: "input.assigneeId",
        label: "Responsável",
        type: "select",
        required: true,
        options: [],
      },
    ],
    baseConfig: { actionId: "assign_ticket" },
  },
  {
    id: "internal.update_priority",
    nodeType: "internal_action",
    category: "internal_action",
    label: "Alterar prioridade",
    description: "Atualiza a urgência operacional do ticket.",
    icon: "flag",
    accent: "amber",
    fields: [
      {
        key: "input.priority",
        label: "Nova prioridade",
        type: "select",
        required: true,
        defaultValue: "high",
        options: [
          { label: "Baixa", value: "low" },
          { label: "Normal", value: "normal" },
          { label: "Alta", value: "high" },
          { label: "Urgente", value: "urgent" },
        ],
      },
    ],
    baseConfig: { actionId: "change_priority" },
  },
  {
    id: "internal.update_status",
    nodeType: "internal_action",
    category: "internal_action",
    label: "Alterar status",
    description: "Move o ticket para outra etapa do atendimento.",
    icon: "refresh-cw",
    accent: "blue",
    fields: [
      {
        key: "input.status",
        label: "Novo status",
        type: "select",
        required: true,
        defaultValue: "blocked",
        options: [
          { label: "Em revisão", value: "triage" },
          { label: "Em andamento", value: "in_progress" },
          { label: "Aguardando resposta", value: "waiting_customer" },
          { label: "Aguardando interno", value: "blocked" },
          { label: "Arquivado", value: "archived" },
        ],
        description: "Arquivar exige que o ticket já esteja resolvido. Use o gatilho “Ticket resolvido” antes desta ação.",
      },
    ],
    baseConfig: { actionId: "change_status" },
  },
  {
    id: "internal.add_note",
    nodeType: "internal_action",
    category: "internal_action",
    label: "Adicionar nota interna",
    description: "Registra contexto visível somente no Threadmark.",
    icon: "notebook-pen",
    accent: "blue",
    fields: [
      {
        key: "input.body",
        label: "Conteúdo da nota",
        type: "textarea",
        required: true,
        placeholder: "Use campos como {{ticket.title}}.",
      },
    ],
    baseConfig: { actionId: "add_internal_note" },
  },
  {
    id: "internal.create_notification",
    nodeType: "internal_action",
    category: "internal_action",
    label: "Criar notificação",
    description: "Registra um aviso na central interna do Threadmark.",
    icon: "bell-ring",
    accent: "violet",
    fields: [
      {
        key: "input.recipient",
        label: "Destinatários",
        type: "select",
        required: true,
        defaultValue: "assignee",
        options: [
          { label: "Responsável pelo ticket", value: "assignee" },
          { label: "Toda a equipe", value: "all" },
        ],
      },
      {
        key: "input.title",
        label: "Título",
        type: "text",
        required: true,
        supportsVariables: true,
        defaultValue: "Ticket #{{ticket.number}} precisa de atenção",
      },
      {
        key: "input.body",
        label: "Mensagem",
        type: "textarea",
        required: true,
        supportsVariables: true,
        defaultValue: "{{ticket.title}} · {{ticket.client.name}}",
      },
      {
        key: "input.targetUrl",
        label: "Tela ao abrir",
        description: "Caminho interno aberto quando a pessoa clicar na notificação.",
        type: "text",
        supportsVariables: true,
        defaultValue: "/tickets/{{ticket.number}}",
      },
    ],
    baseConfig: {
      actionId: "create_in_app_notification",
      retry: { maxAttempts: 3, delayMs: 30_000 },
    },
  },
  {
    id: "app.slack.send_message",
    nodeType: "app_action",
    category: "connected_app",
    label: "Enviar ao Slack",
    description: "Publica uma mensagem em um canal autorizado.",
    icon: "message-square-share",
    accent: "violet",
    connected: false,
    connectionLabel: "Slack",
    fields: [
      {
        key: "input.text",
        label: "Mensagem",
        type: "textarea",
        required: true,
        defaultValue: "{{ticket.title}} — {{ticket.client.name}}",
      },
    ],
    baseConfig: { appId: "slack-webhook", connectionId: "", actionId: "send_message" },
  },
  {
    id: "app.linear.create_issue",
    nodeType: "app_action",
    category: "connected_app",
    label: "Criar issue no Linear",
    description: "Cria uma demanda e devolve o vínculo ao ticket.",
    icon: "square-kanban",
    accent: "violet",
    connected: false,
    connectionLabel: "Linear",
    fields: [
      {
        key: "input.teamId",
        label: "Time",
        type: "text",
        required: true,
      },
      {
        key: "input.title",
        label: "Título",
        type: "text",
        required: true,
        defaultValue: "{{ticket.title}}",
      },
      {
        key: "input.description",
        label: "Descrição",
        type: "textarea",
        required: true,
        defaultValue: "{{ticket.description}}",
      },
    ],
    baseConfig: { appId: "linear", connectionId: "", actionId: "create_issue" },
  },
  {
    id: "app.intercom.create_article",
    nodeType: "app_action",
    category: "connected_app",
    label: "Criar rascunho no Intercom",
    description: "Cria um artigo revisável sem publicar automaticamente.",
    icon: "book-open-text",
    accent: "violet",
    connected: false,
    connectionLabel: "Intercom",
    fields: [
      {
        key: "input.collectionId",
        label: "Coleção",
        type: "text",
        required: true,
      },
      {
        key: "input.documentId",
        label: "Documentação do Threadmark",
        type: "text",
        required: true,
        defaultValue: "{{documentation.id}}",
      },
    ],
    baseConfig: { appId: "intercom", connectionId: "", actionId: "create_article" },
  },
  {
    id: "app.custom.http_request",
    nodeType: "app_action",
    category: "connected_app",
    label: "Executar API personalizada",
    description: "Chama uma ação segura de um app configurado.",
    icon: "webhook",
    accent: "violet",
    connected: false,
    connectionLabel: "API personalizada",
    fields: [
      {
        key: "input.body",
        label: "Corpo da requisição",
        type: "textarea",
        required: true,
        placeholder: "Use um objeto JSON ou campos como {{ticket.id}}.",
      },
    ],
    baseConfig: { appId: "custom-http", connectionId: "", actionId: "request" },
  },
];

export function initialNodeConfig(definition: AutomationNodeDefinition): AutomationNodeConfig {
  let config: AutomationNodeConfig = { ...definition.baseConfig };
  for (const field of definition.fields) {
    config = setAutomationConfigValue(config, field.key, field.defaultValue ?? "");
  }
  return config;
}

export function automationNodeDefinition(
  id: string,
  catalog: AutomationNodeDefinition[] = defaultAutomationNodeCatalog,
): AutomationNodeDefinition | null {
  return catalog.find((definition) => definition.id === id) ?? null;
}

export function automationNodeCatalogId(
  node: { type: string; config: AutomationNodeConfig },
): string {
  if (node.type === "trigger") return `trigger.${String(node.config.eventType ?? "")}`;
  if (node.type === "condition" || node.type === "wait" || node.type === "approval") {
    return `flow.${node.type}`;
  }
  if (node.type === "internal_action") {
    const actionId = String(node.config.actionId ?? "");
    return {
      assign_ticket: "internal.assign",
      change_priority: "internal.update_priority",
      change_status: "internal.update_status",
      add_internal_note: "internal.add_note",
      create_in_app_notification: "internal.create_notification",
      send_push_notification: "internal.create_notification",
    }[actionId] ?? `internal.${actionId}`;
  }
  if (node.type === "app_action") {
    const connectionId = String(node.config.connectionId ?? "");
    if (connectionId) {
      return `app-connection.${connectionId}.${String(node.config.actionId ?? "")}`;
    }
    const appId = String(node.config.appId ?? "");
    const actionId = String(node.config.actionId ?? "");
    if (appId === "slack-webhook") return "app.slack.send_message";
    if (appId === "custom-http") return "app.custom.http_request";
    return `app.${appId}.${actionId}`;
  }
  return node.type;
}

export function getAutomationConfigValue(
  config: AutomationNodeConfig,
  path: string,
): AutomationNodeConfigValue | undefined {
  let current: AutomationNodeConfigValue = config;
  for (const part of path.split(".")) {
    if (!current || Array.isArray(current) || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function setAutomationConfigValue(
  config: AutomationNodeConfig,
  path: string,
  value: AutomationNodeConfigValue,
): AutomationNodeConfig {
  const parts = path.split(".");
  const root = structuredClone(config);
  let current = root;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    const nested = current[part];
    if (!nested || Array.isArray(nested) || typeof nested !== "object") current[part] = {};
    current = current[part] as AutomationNodeConfig;
  });
  return root;
}

export function catalogWithConnectedApps(
  connections: ConnectedAppSummary[],
  recipients: Array<{ id: string; displayName: string; role?: string }> = [],
): AutomationNodeDefinition[] {
  const teamMemberOptions = recipients.map((recipient) => ({
    label: recipient.role
      ? `${recipient.displayName} · ${teamRoleLabel(recipient.role)}`
      : recipient.displayName,
    value: recipient.id,
  }));
  const internal = defaultAutomationNodeCatalog
    .filter((definition) => definition.category !== "connected_app")
    .map((definition) => {
      if (definition.id === "internal.assign") {
        return {
          ...definition,
          fields: definition.fields.map((field) =>
            field.key === "input.assigneeId"
              ? { ...field, options: teamMemberOptions }
              : field,
          ),
        };
      }
      if (definition.id !== "internal.create_notification") return definition;
      return {
        ...definition,
        fields: definition.fields.map((field) =>
          field.key === "input.recipient"
            ? {
                ...field,
                options: [
                  ...(field.options ?? []),
                  ...recipients.map((recipient) => ({
                    label: recipient.displayName,
                    value: `user:${recipient.id}`,
                  })),
                ],
              }
            : field,
        ),
      };
    });
  const connectedNodes: AutomationNodeDefinition[] = [];
  for (const connection of connections.filter((item) => item.status === "active")) {
    const templateId =
      connection.type === "slack_webhook"
        ? "app.slack.send_message"
        : "app.custom.http_request";
    const template = defaultAutomationNodeCatalog.find((item) => item.id === templateId);
    if (!template) continue;
    const actionId = connection.type === "slack_webhook" ? "send_message" : "request";
    connectedNodes.push({
      ...template,
      id: `app-connection.${connection.id}.${actionId}`,
      label: `${template.label} · ${connection.name}`,
      connected: true,
      connectionLabel: connection.name,
      baseConfig: {
        ...template.baseConfig,
        connectionId: connection.id,
        actionId,
      },
    });
  }
  return [...internal, ...connectedNodes];
}

function teamRoleLabel(role: string): string {
  if (role === "owner") return "Proprietário";
  if (role === "admin") return "Administrador";
  if (role === "operator") return "Operador";
  return role;
}
