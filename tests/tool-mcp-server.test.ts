import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createDatabase } from "../server/db/index.js";
import { readToolBridgeResults } from "../server/agent/tool-bridge-manifest.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { DeepToolExecutor } from "../server/tools/deep-tool-executor.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

test("servidor MCP descobre e executa ferramenta readonly em outro processo", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-mcp-e2e-"));
  const codeRoot = path.join(temporary, "code");
  const dataDir = path.join(temporary, "data");
  const databasePath = path.join(dataDir, "threadmark.sqlite");
  const manifestPath = path.join(temporary, "manifest.json");
  const resultLogPath = path.join(temporary, "results.jsonl");
  await mkdir(path.join(codeRoot, "server"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(codeRoot, "server", "campaign.ts"),
    "export const CAMPAIGN_DELIVERY_STATE = 'READY';\n",
  );
  const database = createDatabase(databasePath);
  const vault = new LocalSecretVault(path.join(dataDir, "secrets"));
  const localTools = new LocalToolService(database, vault);
  await localTools.create({
    type: "codebase",
    name: "Código de campanhas",
    description: "Regras de entrega de campanha",
    config: { rootPath: codeRoot },
    allowedOperations: ["search_files", "read_files"],
  }, "test");
  const descriptors = new DeepToolExecutor(localTools).descriptors();
  database.close();
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    databasePath,
    dataDir,
    commandHome: temporary,
    resultLogPath,
    authorizedDescriptors: descriptors,
    maxOperations: 4,
    maxSameOperation: 3,
    maxCodeSearchOperations: 2,
  }), { mode: 0o600 });
  await writeFile(resultLogPath, "", { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      requireResolve("tsx/cli"),
      path.resolve("server/agent/tool-mcp-server.ts"),
    ],
    env: {
      PATH: process.env.PATH ?? "",
      THREADMARK_TOOL_BRIDGE_MANIFEST: manifestPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "threadmark-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "execute_tool",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "buscar regra de campanha no código", limit: 2 },
    });
    assert.equal(search.isError, undefined);
    assert.match(JSON.stringify(search.content), /search_files/);

    const descriptor = descriptors[0];
    assert.ok(descriptor);
    const execution = await client.callTool({
      name: "execute_tool",
      arguments: {
        requestId: "mcp-e2e-search",
        toolId: descriptor.id,
        operation: "search_files",
        argumentsJson: JSON.stringify({
          query: "CAMPAIGN_DELIVERY_STATE",
          path: "server",
          glob: "*.ts",
          maxResults: 10,
        }),
        purpose: "Localizar a regra de entrega.",
      },
    });
    assert.equal(execution.isError, undefined);
    assert.match(JSON.stringify(execution.content), /CAMPAIGN_DELIVERY_STATE/);

    const audited = await readToolBridgeResults(resultLogPath);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.status, "success");
    assert.match(audited[0]?.content ?? "", /campaign\.ts/);
  } finally {
    await client.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});

function requireResolve(specifier: string): string {
  return import.meta.resolve(specifier).replace(/^file:\/\//u, "");
}
