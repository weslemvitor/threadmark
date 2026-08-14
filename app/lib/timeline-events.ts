import type { TimelineEventDto } from "./types.js";
import { statusLabels } from "./format.js";

function dataString(event: TimelineEventDto, key: string): string | null {
  const value = event.metadata[key] ?? event.data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dataNumber(event: TimelineEventDto, key: string): number | null {
  const value = event.metadata[key] ?? event.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function confidenceSuffix(event: TimelineEventDto): string {
  const confidence = dataNumber(event, "confidence");
  if (confidence === null) return "";
  return ` · ${Math.round(confidence * 100)}% de confiança`;
}

export function describeTimelineEvent(event: TimelineEventDto): string {
  if (event.description.trim()) return event.description.trim();

  if (event.fromStatus && event.toStatus) {
    return `Status alterado de ${statusLabels[event.fromStatus]} para ${statusLabels[event.toStatus]}`;
  }

  switch (event.eventType) {
    case "ticket_created":
      return "Ticket criado a partir da conversa do WhatsApp";
    case "message_attached":
      return "Nova mensagem adicionada ao contexto do ticket";
    case "status_changed":
      return event.toStatus
        ? `Status alterado para ${statusLabels[event.toStatus]}`
        : "Status interno do ticket atualizado";
    case "ticket_context_changed": {
      const clientName = dataString(event, "clientName");
      const storeName = dataString(event, "affectedStoreName");
      return clientName
        ? `Ticket associado a ${clientName}${storeName ? ` · ${storeName}` : ""}`
        : "Organização e operação associadas ao ticket";
    }
    case "internal_note_added": {
      const actor = event.actor.trim();
      return actor
        ? `${actor} adicionou uma nota interna`
        : "Nota interna adicionada ao ticket";
    }
    case "internal_note_updated":
      return `${event.actor.trim() || "Operador local"} editou uma nota interna`;
    case "internal_note_deleted":
      return `${event.actor.trim() || "Operador local"} excluiu uma nota interna`;
    case "ticket_forwarded_to_product": {
      const title = dataString(event, "title");
      return title
        ? `Bug encaminhado para Produto · ${title}`
        : "Bug encaminhado para Produto";
    }
    case "ticket_product_forwarding_updated": {
      const title = dataString(event, "title");
      return title
        ? `Bug encaminhado atualizado · ${title}`
        : "Bug encaminhado para Produto atualizado";
    }
    case "investigation_queued":
      return dataString(event, "reason") ===
        "context_changed_while_investigation_was_running"
        ? "Nova investigação automática agendada após mudança no contexto"
        : "Investigação automática adicionada à fila do Codex";
    case "investigation_rerun_requested":
      return "Nova análise solicitada porque chegaram informações durante a investigação";
    case "investigation_completed":
      return `Codex concluiu a investigação automática${confidenceSuffix(event)}`;
    case "investigation_thread_message_queued":
      return "Investigação aprofundada solicitada ao Codex";
    case "investigation_thread_turn_completed": {
      const phase = dataString(event, "phase");
      const phaseLabel =
        phase === "conclusion"
          ? "Conclusão registrada"
          : phase === "needs_information"
            ? "Mais informações necessárias"
            : "Análise registrada";
      return `Codex executou a investigação aprofundada · ${phaseLabel}${confidenceSuffix(event)}`;
    }
    default: {
      const actor = event.actor.trim() || "Sistema";
      return `${actor} registrou uma atualização interna (${event.eventType})`;
    }
  }
}

export function isInternalNoteTimelineEvent(event: TimelineEventDto): boolean {
  return event.eventType === "internal_note_added";
}

export function isOperationalTimelineEvent(event: TimelineEventDto): boolean {
  return !isInternalNoteTimelineEvent(event);
}
