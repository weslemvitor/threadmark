import path from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import Database from "better-sqlite3";
import { z } from "zod";

import { ConnectedAppService } from "../integrations/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";
import { DeepToolExecutor } from "../tools/deep-tool-executor.js";
import { LocalToolService } from "../tools/local-tool-service.js";
import { boundToolResultForModel, ThreadmarkToolBridge } from "./tool-bridge.js";
import {
  appendToolBridgeResult,
  readToolBridgeManifest,
} from "./tool-bridge-manifest.js";

const manifestPath = process.env.THREADMARK_TOOL_BRIDGE_MANIFEST?.trim();
if (!manifestPath || !path.isAbsolute(manifestPath)) {
  throw new Error("Manifesto MCP do Threadmark ausente ou inválido.");
}

const manifest = await readToolBridgeManifest(manifestPath);
if (manifest.commandHome) process.env.HOME = manifest.commandHome;
const database = new Database(manifest.databasePath, {
  readonly: true,
  fileMustExist: true,
});
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
const vault = new LocalSecretVault(path.join(manifest.dataDir, "secrets"));
const executor = new DeepToolExecutor(
  new LocalToolService(database, vault),
  {
    database,
    connectedApps: new ConnectedAppService(database, vault),
    integrationVault: vault,
  },
);
const bridge = new ThreadmarkToolBridge(executor, manifest.authorizedDescriptors, {
  maxOperations: manifest.maxOperations,
  maxSameOperation: manifest.maxSameOperation,
  maxCodeSearchOperations: manifest.maxCodeSearchOperations,
  onExecution: (result) => appendToolBridgeResult(manifest.resultLogPath, result),
});
const server = new McpServer(
  { name: "threadmark-readonly-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "search_tools",
  {
    title: "Descobrir ferramentas readonly do Threadmark",
    description:
      "Busca no catálogo autorizado desta investigação e devolve somente os contratos relevantes. Deve ser chamada antes de execute_tool.",
    inputSchema: z.object({
      query: z.string().trim().min(2).max(1_000),
      limit: z.number().int().min(1).max(10).default(6),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    const result = bridge.search(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

server.registerTool(
  "execute_tool",
  {
    title: "Executar ferramenta readonly descoberta",
    description:
      "Executa uma operação previamente devolvida por search_tools. O broker valida novamente autorização, schema, escopo, credenciais e orçamento.",
    inputSchema: z.object({
      requestId: z.string().trim().min(1).max(200),
      toolId: z.string().trim().min(1).max(500),
      operation: z.string().trim().min(1).max(200),
      argumentsJson: z.string().trim().min(2).max(100_000),
      purpose: z.string().trim().min(1).max(2_000),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    const result = await bridge.execute(input);
    const modelResult = boundToolResultForModel(result);
    return {
      content: [{ type: "text", text: JSON.stringify(modelResult) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const close = async (): Promise<void> => {
  await server.close().catch(() => undefined);
  database.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
