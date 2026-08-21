import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTimelineEvent,
  isInternalNoteTimelineEvent,
  isOperationalTimelineEvent,
} from "../app/lib/timeline-events.js";
import type { TimelineEventDto } from "../shared/contracts.js";

function event(overrides: Partial<TimelineEventDto>): TimelineEventDto {
  return {
    type: "event",
    id: "event-1",
    occurredAt: "2026-07-17T03:00:00.000Z",
    eventType: "ticket_created",
    description: "",
    actor: "system",
    fromStatus: null,
    toStatus: null,
    metadata: {},
    data: {},
    ...overrides,
  };
}

test("timeline descreve mudanças de status e ações do Codex", () => {
  assert.equal(
    describeTimelineEvent(event({ fromStatus: "triage", toStatus: "in_progress" })),
    "Status alterado de Em revisão para Em andamento",
  );
  assert.equal(
    describeTimelineEvent(
      event({ eventType: "investigation_completed", actor: "Codex", data: { confidence: 0.96 } }),
    ),
    "Codex concluiu a investigação automática · 96% de confiança",
  );
  assert.equal(
    describeTimelineEvent(
      event({
        eventType: "investigation_thread_turn_completed",
        actor: "Codex",
        data: { phase: "needs_information", confidence: 0.81 },
      }),
    ),
    "Threadmark AI concluiu uma análise · Mais informações necessárias · 81% de confiança",
  );
});

test("timeline explica reanálise automática causada por contexto novo", () => {
  assert.equal(
    describeTimelineEvent(
      event({
        eventType: "investigation_queued",
        data: { reason: "context_changed_while_investigation_was_running" },
      }),
    ),
    "Nova investigação automática agendada após mudança no contexto",
  );
});

test("timeline identifica notas internas sem confundir com mensagens do WhatsApp", () => {
  const note = event({
    eventType: "internal_note_added",
    actor: "Operador de teste",
    metadata: { body: "Aguardando retorno técnico." },
  });
  assert.equal(
    describeTimelineEvent(note),
    "Operador de teste adicionou uma nota interna",
  );
  assert.equal(isInternalNoteTimelineEvent(note), true);
  assert.equal(isOperationalTimelineEvent(note), false);
});

test("edição e exclusão de nota permanecem como eventos auditáveis e ocultáveis", () => {
  const updated = event({
    id: "note-update-1",
    eventType: "internal_note_updated",
    actor: "Operador de teste",
    metadata: { noteId: "note-1" },
  });
  const deleted = event({
    id: "note-delete-1",
    eventType: "internal_note_deleted",
    actor: "Operador de teste",
    metadata: { noteId: "note-1" },
  });

  assert.equal(describeTimelineEvent(updated), "Operador de teste editou uma nota interna");
  assert.equal(describeTimelineEvent(deleted), "Operador de teste excluiu uma nota interna");
  assert.equal(isInternalNoteTimelineEvent(updated), false);
  assert.equal(isInternalNoteTimelineEvent(deleted), false);
  assert.equal(isOperationalTimelineEvent(updated), true);
  assert.equal(isOperationalTimelineEvent(deleted), true);
});

test("timeline classifica o encaminhamento de bug como evento operacional", () => {
  const bug = event({
    eventType: "ticket_forwarded_to_product",
    metadata: { title: "Pedidos ausentes no dashboard" },
  });
  assert.equal(
    describeTimelineEvent(bug),
    "Bug encaminhado para Produto · Pedidos ausentes no dashboard",
  );
  assert.equal(isOperationalTimelineEvent(bug), true);

  const updated = event({
    eventType: "ticket_product_forwarding_updated",
    metadata: { title: "Pedidos ausentes no dashboard" },
  });
  assert.equal(
    describeTimelineEvent(updated),
    "Bug encaminhado atualizado · Pedidos ausentes no dashboard",
  );
  assert.equal(isOperationalTimelineEvent(updated), true);
});

test("timeline descreve a associação manual de organização e operação", () => {
  assert.equal(
    describeTimelineEvent(
      event({
        eventType: "ticket_context_changed",
        data: {
          clientName: "Organização Fictícia Delta",
          affectedStoreName: "Loja Exemplo Ômega",
        },
      }),
    ),
    "Ticket associado a Organização Fictícia Delta · Loja Exemplo Ômega",
  );
});
