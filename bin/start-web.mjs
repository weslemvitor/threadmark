#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "vinext/server/prod-server";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST?.trim() || "127.0.0.1";

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Porta web inválida: ${process.env.PORT ?? "vazia"}.`);
}

await startProdServer({
  host,
  port,
  outDir: path.join(projectRoot, "dist"),
});
