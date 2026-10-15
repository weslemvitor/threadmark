import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHeadlessHttpTransport,
  executeHeadlessCommand,
  HEADLESS_SCHEMA_VERSION,
  readHeadlessStandardInput,
  type HeadlessRequest,
  type HeadlessTransport,
} from "../server/headless/cli.js";

test("transporte HTTP rejeita resposta 2xx que não contém JSON", async () => {
  const transport = createHeadlessHttpTransport({
    apiUrl: "https://threadmark.example",
    token: "token-de-teste",
    fetch: async () => new Response("<html>erro</html>", { status: 200 }),
  });

  await assert.rejects(
    () => transport.request("/api/tickets"),
    /resposta JSON válida/i,
  );
});

interface CapturedRequest {
  route: string;
  input: HeadlessRequest | undefined;
}

function recordingTransport(
  respond: (route: string, input?: HeadlessRequest) => unknown,
): { transport: HeadlessTransport; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    transport: {
      async request<T>(route: string, input?: HeadlessRequest): Promise<T> {
        requests.push({ route, input });
        return respond(route, input) as T;
      },
    },
  };
}

test("CLI headless recompõe UTF-8 dividido na entrada padrão", async () => {
  async function* chunks(): AsyncGenerator<Buffer> {
    yield Buffer.from('{"summary":"Ol');
    yield Buffer.from([0xC3]);
    yield Buffer.from([0xA1, 0x20, 0xF0, 0x9F]);
    yield Buffer.from([0x8D, 0x95, 0x22, 0x7D]);
  }

  assert.equal(await readHeadlessStandardInput(chunks()), '{"summary":"Olá 🍕"}');
});

test("CLI headless publica capacidades e limites de segurança sem acessar a API", async () => {
  const current = recordingTransport(() => {
    throw new Error("não deveria consultar a API");
  });

  const result = await executeHeadlessCommand(
    "capabilities",
    ["--json"],
    current.transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, HEADLESS_SCHEMA_VERSION);
  assert.equal(current.requests.length, 0);
  if (!result.ok) return;
  assert.deepEqual(
    (result.data as { safety: Record<string, boolean> }).safety,
    {
      whatsappOutbound: false,
      directDatabaseWrites: false,
      writesRequireApplyFlag: true,
      writesRequireActor: true,
      secretsInOutput: false,
    },
  );
});

test("CLI headless limita e codifica buscas de conversa", async () => {
  const current = recordingTransport(() => ({ items: [], total: 0 }));

  const result = await executeHeadlessCommand(
    "conversations",
    ["list", "--query", "Loja Exemplo & Suporte", "--scope", "group", "--limit", "30"],
    current.transport,
  );

  assert.equal(result.ok, true);
  assert.equal(current.requests.length, 1);
  const route = new URL(current.requests[0]!.route, "http://threadmark.local");
  assert.equal(route.pathname, "/api/conversations");
  assert.equal(route.searchParams.get("q"), "Loja Exemplo & Suporte");
  assert.equal(route.searchParams.get("scope"), "group");
  assert.equal(route.searchParams.get("limit"), "30");
});

test("CLI headless recusa qualquer escrita sem autorização e ator explícitos", async () => {
  const current = recordingTransport(() => ({ id: "unexpected" }));

  const withoutApply = await executeHeadlessCommand(
    "tickets",
    ["status", "#123", "--input", "unused.json"],
    current.transport,
  );
  assert.equal(withoutApply.ok, false);
  if (withoutApply.ok) return;
  assert.equal(withoutApply.error.code, "confirmation_required");
  assert.equal(current.requests.length, 0);

  const withoutActor = await executeHeadlessCommand(
    "tickets",
    ["create", "--input", "unused.json", "--apply"],
    current.transport,
  );
  assert.equal(withoutActor.ok, false);
  if (withoutActor.ok) return;
  assert.equal(withoutActor.error.code, "actor_required");
});

test("CLI headless cria ticket de conversa com JSON validado, idempotência e identidade CLI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadmark-headless-"));
  try {
    const inputPath = path.join(directory, "ticket.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        clientRequestId: "hermes-loja-exemplo-20260902",
        messageIds: ["message-1", "message-2"],
        title: "Campanha não enviou mensagens",
        summary: "O cliente informou ausência de envios e o caso precisa de acompanhamento.",
        priority: "high",
      }),
      { mode: 0o600 },
    );
    const current = recordingTransport((route) => {
      if (route === "/api/ticket-assignees") {
        return [{ id: "user-operator", displayName: "Pessoa Operadora", role: "owner" }];
      }
      return { ticket: { id: "ticket-123", number: 123 } };
    });

    const result = await executeHeadlessCommand(
      "triage",
      [
        "create",
        "conversation-example",
        "--input",
        "ticket.json",
        "--apply",
        "--as",
        "Pessoa Operadora",
        "--client",
        "hermes",
      ],
      current.transport,
      { invocationCwd: directory },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.meta, {
      readOnly: false,
      actorId: "user-operator",
      clientId: "threadmark-cli",
    });
    assert.equal(current.requests.length, 2);
    assert.deepEqual(current.requests[1], {
      route: "/api/conversations/conversation-example/triage/tickets",
      input: {
        method: "POST",
        actorId: "user-operator",
        clientId: "threadmark-cli",
        body: {
          clientRequestId: "hermes-loja-exemplo-20260902",
          messageIds: ["message-1", "message-2"],
          title: "Campanha não enviou mensagens",
          summary: "O cliente informou ausência de envios e o caso precisa de acompanhamento.",
          priority: "high",
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI headless resolve número humano antes de consultar o ticket exato", async () => {
  const current = recordingTransport((route) => {
    if (route === "/api/tickets/by-number/123") {
      return { id: "ticket-id-123", number: 123 };
    }
    return { id: "ticket-id-123", number: 123, title: "Falha de envio" };
  });

  const result = await executeHeadlessCommand(
    "tickets",
    ["get", "#123"],
    current.transport,
  );

  assert.equal(result.ok, true);
  assert.equal(current.requests.length, 2);
  assert.equal(current.requests[1]!.route, "/api/tickets/ticket-id-123");
});

test("CLI headless importa mensagens externas em ticket existente", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadmark-headless-"));
  try {
    const inputPath = path.join(directory, "external-messages.json");
    const body = {
      sourceType: "intercom_conversation",
      sourceConversationId: "215475831157843",
      messages: [
        {
          id: "53434216678",
          author: "Robson Da Silva",
          authorRole: "customer",
          body: "Bom dia, gostaria de ajuda para configurar meu ecommerce.",
          occurredAt: "2026-09-08T12:35:01.000Z",
        },
        {
          id: "53434401009",
          author: "Rodrigo",
          authorRole: "support",
          body: "Olá, tudo bem?",
          occurredAt: "2026-09-08T12:37:41.000Z",
        },
      ],
    };
    await writeFile(inputPath, JSON.stringify(body), { mode: 0o600 });
    const current = recordingTransport((route) => {
      if (route === "/api/ticket-assignees") {
        return [{ id: "user-operator", displayName: "Pessoa Operadora", role: "owner" }];
      }
      if (route.startsWith("/api/tickets?")) {
        return {
          items: [{ id: "ticket-id-375", number: 375 }],
          total: 1,
          limit: 100,
          offset: 0,
        };
      }
      return { id: "ticket-id-375", number: 375, messageCount: 2 };
    });

    const result = await executeHeadlessCommand(
      "tickets",
      [
        "external-messages-import",
        "#375",
        "--input",
        "external-messages.json",
        "--apply",
        "--as",
        "Pessoa Operadora",
        "--client",
        "hermes",
      ],
      current.transport,
      { invocationCwd: directory },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(current.requests[2], {
      route: "/api/tickets/ticket-id-375/external-messages",
      input: {
        method: "POST",
        actorId: "user-operator",
        clientId: "threadmark-cli",
        body,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI headless remove nota interna de um ticket com auditoria", async () => {
  const current = recordingTransport((route) => {
    if (route === "/api/ticket-assignees") {
      return [{ id: "user-operator", displayName: "Pessoa Operadora", role: "owner" }];
    }
    return { id: "ticket-id-375", number: 375 };
  });

  const result = await executeHeadlessCommand(
    "tickets",
    [
      "note-delete",
      "ticket-id-375",
      "ticket-note-incorrect",
      "--apply",
      "--as",
      "Pessoa Operadora",
      "--client",
      "hermes",
    ],
    current.transport,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(current.requests[1], {
    route: "/api/tickets/ticket-id-375/notes/ticket-note-incorrect",
    input: {
      method: "DELETE",
      actorId: "user-operator",
      clientId: "threadmark-cli",
    },
  });
});

test("CLI headless expõe a fila de triagem sem alterar estado", async () => {
  const current = recordingTransport(() => ({
    queued: 2,
    running: 0,
    revision: "2026-09-02T12:00:00.000Z",
  }));

  const result = await executeHeadlessCommand(
    "agent",
    ["triage-status"],
    current.transport,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.meta.readOnly, true);
  assert.equal(current.requests[0]!.route, "/api/agent/triage/jobs");
});

test("CLI headless reivindica job externo com identidade CLI sem selecionar agente", async () => {
  const current = recordingTransport((route) => {
    if (route === "/api/ticket-assignees") {
      return [{ id: "user-operator", displayName: "Pessoa Operadora", role: "owner" }];
    }
    return { job: null };
  });

  const result = await executeHeadlessCommand(
    "agent",
    [
      "triage-claim",
      "--lease-seconds",
      "120",
      "--apply",
      "--as",
      "Pessoa Operadora",
    ],
    current.transport,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(current.requests[1], {
    route: "/api/agent/triage/jobs/claim",
    input: {
      method: "POST",
      body: { leaseSeconds: 120 },
      actorId: "user-operator",
      clientId: "threadmark-cli",
    },
  });
});

test("CLI headless rejeita arquivo de entrada acima do limite antes do transporte", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadmark-headless-large-input-"));
  try {
    await writeFile(path.join(directory, "large.json"), "x".repeat(64 * 1024 + 1));
    const current = recordingTransport((route) => {
      if (route === "/api/ticket-assignees") {
        return [{ id: "user-weslem", displayName: "weslem", role: "owner" }];
      }
      throw new Error("não deveria consultar a API após resolver o ator");
    });
    const result = await executeHeadlessCommand(
      "tickets",
      [
        "create",
        "--input",
        "large.json",
        "--apply",
        "--as",
        "weslem",
        "--client",
        "hermes",
        "--json",
      ],
      current.transport,
      { invocationCwd: directory },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "input_too_large");
    assert.equal(current.requests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
