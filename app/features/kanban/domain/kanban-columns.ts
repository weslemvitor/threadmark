import type { TicketStatus } from "../../../lib/types.js";

interface KanbanColumn {
  id: string;
  label: string;
  description: string;
  statuses: TicketStatus[];
  targetStatus: TicketStatus;
  accent: string;
}

export const kanbanColumns: KanbanColumn[] = [
  {
    id: "new",
    label: "Novo",
    description: "Chamados que chegaram e ainda precisam de triagem.",
    statuses: ["new"],
    targetStatus: "new",
    accent: "slate",
  },
  {
    id: "triage",
    label: "Em triagem",
    description: "Identificar o impacto, a prioridade, o responsável e o próximo passo.",
    statuses: ["triage"],
    targetStatus: "triage",
    accent: "violet",
  },
  {
    id: "progress",
    label: "Em atendimento",
    description: "Alguém está investigando ou resolvendo o chamado.",
    statuses: ["in_progress"],
    targetStatus: "in_progress",
    accent: "blue",
  },
  {
    id: "waiting",
    label: "Aguardando",
    description: "Depende do cliente, dos desenvolvedores ou de algum terceiro. Registra o que falta e quando revisar.",
    statuses: ["waiting_customer", "blocked"],
    targetStatus: "waiting_customer",
    accent: "amber",
  },
  {
    id: "done",
    label: "Resolvido",
    description: "Solução aplicada e comunicada ao cliente, com registro do resultado.",
    statuses: ["resolved"],
    targetStatus: "resolved",
    accent: "green",
  },
  {
    id: "cancelled",
    label: "Cancelado",
    description: "Chamados encerrados sem resolução.",
    statuses: ["cancelled"],
    targetStatus: "cancelled",
    accent: "rose",
  },
];
