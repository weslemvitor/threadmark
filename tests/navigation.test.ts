import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThreadmarkPath,
  parseThreadmarkLocation,
} from "../app/lib/navigation.js";

test("rotas principais possuem caminhos canônicos", () => {
  assert.equal(buildThreadmarkPath({ view: "conversations" }), "/conversations");
  assert.equal(buildThreadmarkPath({ view: "inbox" }), "/kanban");
  assert.equal(buildThreadmarkPath({ view: "kanban" }), "/kanban");
  assert.equal(buildThreadmarkPath({ view: "clients" }), "/directory");
  assert.equal(buildThreadmarkPath({ view: "categories" }), "/categories");
  assert.equal(buildThreadmarkPath({ view: "dashboard" }), "/dashboard");
  assert.equal(buildThreadmarkPath({ view: "settings" }), "/settings");
});

test("a antiga listagem de tickets retorna ao Kanban", () => {
  assert.deepEqual(parseThreadmarkLocation("/tickets"), {
    view: "kanban",
    ticketReference: null,
    settingsTab: "general",
    legacy: true,
  });
});

test("ticket recebe URL compartilhável e rotas antigas do agente voltam ao geral", () => {
  assert.equal(
    buildThreadmarkPath({ view: "inbox", ticketReference: "51" }),
    "/tickets/51",
  );
  assert.equal(
    buildThreadmarkPath({ view: "settings", settingsTab: "ai" }),
    "/settings",
  );

  assert.deepEqual(parseThreadmarkLocation("/tickets/51"), {
    view: "inbox",
    ticketReference: "51",
    settingsTab: "general",
    legacy: false,
  });
  assert.deepEqual(parseThreadmarkLocation("/settings/tools"), {
    view: "settings",
    ticketReference: null,
    settingsTab: "general",
    legacy: false,
  });
  assert.deepEqual(parseThreadmarkLocation("/documentation"), {
    view: "conversations",
    ticketReference: null,
    settingsTab: "general",
    legacy: true,
  });
});

test("links antigos por query continuam abrindo e são marcados para canonicalização", () => {
  assert.deepEqual(parseThreadmarkLocation("/", "?view=dashboard"), {
    view: "dashboard",
    ticketReference: null,
    settingsTab: "general",
    legacy: true,
  });
  assert.deepEqual(parseThreadmarkLocation("/", "?settings=tools"), {
    view: "settings",
    ticketReference: null,
    settingsTab: "general",
    legacy: true,
  });
  assert.deepEqual(parseThreadmarkLocation("/", "?view=documentation"), {
    view: "conversations",
    ticketReference: null,
    settingsTab: "general",
    legacy: true,
  });
});
