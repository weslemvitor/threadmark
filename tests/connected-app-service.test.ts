import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { ConnectedAppService } from "../server/integrations/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";

test("Intercom exige token e testa conversas, autor e coleções sem executar mutação", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-intercom-app-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const service = new ConnectedAppService(
    database,
    vault,
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ ok: true });
    },
    async () => [{ address: "93.184.216.34" }],
  );

  try {
    await assert.rejects(
      service.create({
        type: "intercom",
        name: "Intercom",
        enabled: true,
        aiEnabled: true,
        endpoint: "https://api.intercom.io/",
      }, "Operador"),
      /access token/i,
    );
    const app = await service.create({
      type: "intercom",
      name: "Intercom",
      enabled: true,
      aiEnabled: true,
      endpoint: "https://api.intercom.io/articles",
      secret: "token-de-teste",
    }, "Operador");

    assert.equal(app.type, "intercom");
    assert.equal(app.endpointPreview, "https://api.intercom.io/");
    assert.equal(app.secretConfigured, true);
    assert.doesNotMatch(JSON.stringify(app), /token-de-teste/);
    const result = await service.validateConnection(app.id);
    assert.match(result.message, /conversas, autor e coleções/i);
    assert.deepEqual(requests.map((request) => [request.method, request.path]), [
      ["GET", "/conversations?per_page=1"],
      ["GET", "/me"],
      ["GET", "/help_center/collections?per_page=1"],
    ]);
    assert.equal(requests.every((request) => request.authorization === "Bearer token-de-teste"), true);
    assert.equal(requests.some((request) => request.method !== "GET"), false);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("MCP remoto descobre ferramentas e exige autorização separada para IA e automações", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-mcp-app-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const calls: Array<{ method: string; authorization: string | null }> = [];
  const service = new ConnectedAppService(
    database,
    vault,
    async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        id?: string | number;
        method?: string;
      };
      calls.push({
        method: request.method ?? "",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "1.0.0" },
          }
        : request.method === "tools/list"
          ? {
              tools: [{
                name: "create_issue",
                title: "Criar issue",
                description: "Cria uma issue de suporte.",
                inputSchema: {
                  type: "object",
                  properties: {
                    title: { type: "string", title: "Título" },
                    priority: { type: "string", enum: ["low", "high"] },
                  },
                  required: ["title"],
                },
                annotations: { readOnlyHint: false, destructiveHint: false },
              }],
            }
          : request.method === "tools/call"
            ? {
                content: [{ type: "text", text: "Issue criada" }],
                structuredContent: { id: "ISSUE-42" },
              }
            : {};
      return Response.json(
        { jsonrpc: "2.0", id: request.id, result },
        { headers: { "mcp-session-id": "threadmark-test" } },
      );
    },
    async () => [{ address: "93.184.216.34" }],
  );

  try {
    const created = await service.create({
      type: "mcp_remote",
      name: "MCP de tarefas",
      enabled: true,
      aiEnabled: true,
      endpoint: "https://mcp.example.com/mcp",
      secret: "mcp-secret-token",
    }, "Operador");
    assert.equal(created.mcpTools.length, 0);

    const validated = await service.validateConnection(created.id);
    assert.match(validated.message, /1 ferramenta/i);
    const discovered = service.get(created.id);
    assert.equal(discovered.mcpTools[0]?.name, "create_issue");
    assert.equal(discovered.mcpTools[0]?.aiEnabled, false);
    assert.equal(discovered.mcpTools[0]?.automationEnabled, false);
    assert.equal(discovered.mcpTools[0]?.confirmationRequired, true);
    assert.doesNotMatch(JSON.stringify(discovered), /mcp-secret-token/);

    await assert.rejects(
      service.callMcpTool(created.id, "create_issue", { title: "Falha" }, "ai"),
      /não foi autorizada/i,
    );
    await service.update(created.id, {
      type: "mcp_remote",
      name: "MCP de tarefas",
      enabled: true,
      aiEnabled: true,
      endpoint: "",
      mcpTools: [{
        name: "create_issue",
        aiEnabled: true,
        automationEnabled: true,
        confirmationRequired: true,
      }],
    }, "Operador");
    const result = await service.callMcpTool(
      created.id,
      "create_issue",
      { title: "Erro no dashboard", priority: "high" },
      "automation",
    );
    assert.deepEqual(result.structuredContent, { id: "ISSUE-42" });
    assert.equal(calls.some((call) => call.method === "tools/list"), true);
    assert.equal(calls.some((call) => call.method === "tools/call"), true);
    assert.equal(
      calls.filter((call) => call.method).every(
        (call) => call.authorization === "Bearer mcp-secret-token",
      ),
      true,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
