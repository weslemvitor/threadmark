import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { loadConfig } from "../server/runtime/config.js";
import { seedPresentationData } from "../server/seed.js";

test("seed de apresentação cria ambiente rico sem executar o Codex", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-presentation-"));
  const config = loadConfig({
    SUPPORT_DATA_DIR: path.join(temporary, "presentation"),
    SUPPORT_WHATSAPP_ENABLED: "false",
    SUPPORT_AGENT_ENABLED: "true",
  });

  try {
    seedPresentationData(config);
    seedPresentationData(config);

    const database = createDatabase(config.databasePath);
    try {
      const counts = database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM clients) AS clients,
            (SELECT COUNT(*) FROM client_stores WHERE active = 1) AS stores,
            (SELECT COUNT(*) FROM whatsapp_groups) AS groups,
            (SELECT COUNT(*) FROM participants) AS participants,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM tickets) AS tickets,
            (SELECT COUNT(*) FROM tickets WHERE status NOT IN ('resolved', 'cancelled', 'archived')) AS open_tickets,
            (SELECT COUNT(*) FROM tickets WHERE status = 'resolved') AS resolved_tickets,
            (SELECT COUNT(*) FROM investigation_jobs) AS investigations,
            (SELECT COUNT(*) FROM investigation_threads) AS threads,
            (SELECT COUNT(*) FROM suggestions) AS suggestions,
            (SELECT COUNT(*) FROM evidence_queries) AS evidence_queries,
            (SELECT COUNT(*) FROM messages WHERE triage_state = 'unreviewed') AS unreviewed,
            (SELECT COUNT(*) FROM attachments WHERE available = 1) AS attachments`,
        )
        .get() as Record<string, number>;

      assert.deepEqual(counts, {
        clients: 5,
        stores: 8,
        groups: 5,
        participants: 7,
        messages: 27,
        tickets: 11,
        open_tickets: 7,
        resolved_tickets: 4,
        investigations: 0,
        threads: 0,
        suggestions: 0,
        evidence_queries: 0,
        unreviewed: 0,
        attachments: 2,
      });

      const store = new SupportStore(database);
      const openTickets = store.listTickets({
        statuses: ["new", "triage", "in_progress", "waiting_customer", "blocked"],
        limit: 50,
      }).items;
      assert.equal(openTickets.length, 7);
      for (const ticket of openTickets) {
        const detail = store.getTicketDetail(ticket.id);
        assert.equal(detail.latestInvestigation, null);
        assert.equal(detail.investigationThread, null);
        assert.deepEqual(detail.suggestions, []);
      }

      assert.ok(existsSync(path.join(config.attachmentsDir, "presentation", "amostra-feed-loja-exemplo.pdf")));
      assert.ok(existsSync(path.join(config.attachmentsDir, "presentation", "popup-loja-exemplo.svg")));
    } finally {
      database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("seed recusa qualquer diretório que não seja exclusivo de apresentação", () => {
  const config = loadConfig({
    SUPPORT_DATA_DIR: ".data",
    SUPPORT_WHATSAPP_ENABLED: "false",
  });
  assert.throws(
    () => seedPresentationData(config),
    /SUPPORT_DATA_DIR terminado em \/presentation/,
  );
});
