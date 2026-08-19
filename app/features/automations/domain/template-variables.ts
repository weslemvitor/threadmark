export type AutomationTemplateVariable = {
  group: "Ticket" | "Atendimento" | "Pessoas";
  label: string;
  token: string;
  description: string;
};

export type AutomationTemplateInsertion = {
  cursor: number;
  value: string;
};

export function insertAutomationTemplateVariable(
  currentValue: string,
  token: string,
  selectionStart = currentValue.length,
  selectionEnd = selectionStart,
): AutomationTemplateInsertion {
  const start = Math.max(0, Math.min(selectionStart, currentValue.length));
  const end = Math.max(start, Math.min(selectionEnd, currentValue.length));
  return {
    cursor: start + token.length,
    value: `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`,
  };
}

/**
 * Campos seguros expostos pelo contexto de execução das automações.
 * A interface apresenta os rótulos; os tokens são inseridos automaticamente.
 */
export const automationTemplateVariables: AutomationTemplateVariable[] = [
  {
    group: "Ticket",
    label: "Número do ticket",
    token: "{{ticket.number}}",
    description: "Número visível, como 191.",
  },
  {
    group: "Ticket",
    label: "Título do ticket",
    token: "{{ticket.title}}",
    description: "Assunto atual do atendimento.",
  },
  {
    group: "Ticket",
    label: "Descrição do ticket",
    token: "{{ticket.summary}}",
    description: "Resumo interno do problema ou da dúvida.",
  },
  {
    group: "Ticket",
    label: "Prioridade",
    token: "{{ticket.priority}}",
    description: "Prioridade atual do ticket.",
  },
  {
    group: "Ticket",
    label: "Status",
    token: "{{ticket.status}}",
    description: "Etapa atual do ticket.",
  },
  {
    group: "Atendimento",
    label: "Nome do grupo ou cliente",
    token: "{{ticket.client.name}}",
    description: "Nome exibido para a conversa no Threadmark.",
  },
  {
    group: "Atendimento",
    label: "Nome do grupo no WhatsApp",
    token: "{{ticket.group.subject}}",
    description: "Assunto atual do grupo de origem.",
  },
  {
    group: "Pessoas",
    label: "Nome do solicitante",
    token: "{{ticket.requester.displayName}}",
    description: "Disponível quando o solicitante estiver identificado.",
  },
  {
    group: "Pessoas",
    label: "Telefone do solicitante",
    token: "{{ticket.requester.phoneE164}}",
    description: "Disponível quando houver telefone identificado.",
  },
  {
    group: "Pessoas",
    label: "Nome do responsável",
    token: "{{ticket.assignee.displayName}}",
    description: "Disponível quando o ticket estiver atribuído.",
  },
];
