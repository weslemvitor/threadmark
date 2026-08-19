import type { IntegrationAppDescriptor } from "../types.js";

/**
 * Internal actions are descriptions only. Their trusted execution belongs to
 * the automation engine, never to a generic connector or HTTP callback.
 */
export const THREADMARK_APP = {
  id: "threadmark",
  name: "Threadmark",
  description: "Organize tickets e registre contexto operacional local.",
  category: "threadmark",
  capabilities: ["ticket_management", "internal_note"],
  actions: [
    action("assign_ticket", "Atribuir responsável", "Atribui um membro da equipe ao ticket.", "ticket_management"),
    action("change_status", "Alterar status", "Move o ticket para outro estado do fluxo.", "ticket_management"),
    action("change_priority", "Alterar prioridade", "Atualiza a prioridade interna do ticket.", "ticket_management"),
    action("add_category", "Adicionar categoria", "Vincula uma categoria existente ao ticket.", "ticket_management"),
    action("add_internal_note", "Adicionar nota interna", "Registra uma nota interna no histórico do ticket.", "internal_note"),
  ],
} as const satisfies IntegrationAppDescriptor<"threadmark">;

function action(
  id: string,
  name: string,
  description: string,
  capability: "ticket_management" | "internal_note",
) {
  return {
    appId: "threadmark",
    id,
    name,
    description,
    capability,
    executionMode: "internal",
    idempotency: "engine",
  } as const;
}
