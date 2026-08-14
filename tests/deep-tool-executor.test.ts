import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import {
  DeepToolExecutor,
  type PostgresQueryRequest,
} from "../server/tools/deep-tool-executor.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

test("executor profundo lê somente dentro da raiz explicitamente autorizada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-deep-tool-"));
  const root = path.join(temporary, "code");
  const outside = path.join(temporary, "outside.txt");
  await mkdir(path.join(root, "server"), { recursive: true });
  await mkdir(path.join(root, ".data"), { recursive: true });
  await mkdir(path.join(root, "auth"), { recursive: true });
  await writeFile(path.join(root, "server", "metric.ts"), "export const total = recurring + newCustomers;\n");
  await writeFile(path.join(root, ".env"), "TOKEN=never-expose\n");
  await writeFile(path.join(root, ".env.example"), "TOKEN=example\n");
  await writeFile(path.join(root, ".data", "session.json"), "secret session\n");
  await writeFile(path.join(root, "auth", "credentials.json"), "secret credentials\n");
  await writeFile(outside, "segredo fora da raiz\n");
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "codebase",
    name: "Código do produto",
    description: "Regras de negócio",
    config: { rootPath: root },
    allowedOperations: ["list_files", "search_files", "read_files"],
  }, "test");
  const executor = new DeepToolExecutor(service);

  try {
    const descriptor = executor.descriptors()[0];
    assert.equal(descriptor?.id, tool.id);
    assert.deepEqual(descriptor?.operations.map((item) => item.name), [
      "list_files",
      "search_files",
      "read_files",
    ]);

    const read = await executor.execute({
      requestId: "read-1",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: ["server/metric.ts"], maxLines: 20 }),
      purpose: "Confirmar a fórmula.",
    });
    assert.equal(read.status, "success");
    assert.match(read.content, /recurring \+ newCustomers/);
    assert.match(read.content, /1: export const total/);

    const traversal = await executor.execute({
      requestId: "read-2",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: ["../outside.txt"] }),
      purpose: "Tentar sair da raiz.",
    });
    assert.equal(traversal.status, "error");
    assert.doesNotMatch(traversal.content, /segredo fora da raiz/);
    assert.match(traversal.summary, /raiz autorizada/i);

    const sensitive = await executor.execute({
      requestId: "read-sensitive",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: [".env"] }),
      purpose: "Tentar ler segredo.",
    });
    assert.equal(sensitive.status, "error");
    assert.doesNotMatch(sensitive.content, /never-expose/);
    assert.match(sensitive.summary, /sensíveis/i);

    const example = await executor.execute({
      requestId: "read-example",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: [".env.example"] }),
      purpose: "Ler template público.",
    });
    assert.equal(example.status, "success");
    assert.match(example.content, /TOKEN=example/);

    const listing = await executor.execute({
      requestId: "list-sensitive",
      toolId: tool.id,
      operation: "list_files",
      argumentsJson: JSON.stringify({ path: ".", maxDepth: 3, maxFiles: 100 }),
      purpose: "Listar arquivos permitidos.",
    });
    assert.equal(listing.status, "success");
    assert.match(listing.content, /^\.env\.example$/m);
    assert.doesNotMatch(listing.content, /^\.env$/m);
    assert.doesNotMatch(listing.content, /^\.data\//m);
    assert.doesNotMatch(listing.content, /^auth\//m);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PostgreSQL usa o driver interno, rejeita mutações e aplica limites readonly", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-postgres-tool-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "postgres_readonly",
    name: "Produção readonly",
    config: {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "support_readonly",
      sslMode: "require",
    },
    secrets: { password: "database-password" },
    allowedOperations: ["describe_schema", "query_readonly"],
  }, "test");
  const postgresRequests: PostgresQueryRequest[] = [];
  let postgresFailure: Error | null = null;
  const executor = new DeepToolExecutor(service, {
    async commandRunner() {
      throw new Error("O executor PostgreSQL não deve chamar um binário externo.");
    },
    async postgresRunner(request) {
      postgresRequests.push(request);
      if (postgresFailure) throw postgresFailure;
      return "id,status\n42,paid";
    },
  });

  try {
    const mutation = await executor.execute({
      requestId: "sql-1",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "DELETE FROM orders" }),
      purpose: "Operação proibida.",
    });
    assert.equal(mutation.status, "error");
    assert.equal(postgresRequests.length, 0);

    for (const dangerousQuery of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_catalog.pg_ls_dir('.')",
      "SELECT pg_terminate_backend(42)",
      "SELECT dblink('foreign', 'SELECT 1')",
      "SELECT public.custom_support_function()",
    ]) {
      const dangerous = await executor.execute({
        requestId: `danger-${postgresRequests.length}-${dangerousQuery.length}`,
        toolId: tool.id,
        operation: "query_readonly",
        argumentsJson: JSON.stringify({ query: dangerousQuery }),
        purpose: "Operação proibida.",
      });
      assert.equal(dangerous.status, "error", dangerousQuery);
      assert.equal(postgresRequests.length, 0, dangerousQuery);
    }

    const select = await executor.execute({
      requestId: "sql-2",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({
        query: "SELECT id, status FROM orders WHERE id = 42",
        maxRows: 10,
      }),
      purpose: "Confirmar pedido.",
    });
    assert.equal(select.status, "success");
    assert.equal(postgresRequests.length, 1);
    const selectRequest = postgresRequests[0]!;
    assert.deepEqual(selectRequest.config, {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "support_readonly",
      sslMode: "require",
    });
    assert.equal(selectRequest.password, "database-password");
    assert.equal(
      selectRequest.query,
      "SELECT * FROM (SELECT id, status FROM orders WHERE id = 42) AS threadmark_readonly_query LIMIT 10",
    );
    assert.equal(selectRequest.timeoutMs, 20_000);
    assert.equal(selectRequest.statementTimeoutMs, 15_000);
    assert.equal(selectRequest.lockTimeoutMs, 5_000);
    assert.equal(select.content, "id,status\n42,paid");
    assert.match(select.reference ?? "", /:request:sql-2$/);
    assert.doesNotMatch(JSON.stringify(select), /database-password/);

    const secondSelect = await executor.execute({
      requestId: "sql-3",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders WHERE id = 43" }),
      purpose: "Confirmar outro pedido.",
    });
    assert.equal(secondSelect.status, "success");
    assert.notEqual(secondSelect.reference, select.reference);
    assert.match(secondSelect.reference ?? "", /:request:sql-3$/);

    const connection = await executor.test(tool.id);
    assert.equal(connection.ok, true);
    assert.equal(connection.mode, "connection");
    assert.equal(postgresRequests.at(-1)?.query, "SELECT 1 AS ok");
    assert.equal(service.get(tool.id).lastTestStatus, "success");

    const schema = await executor.execute({
      requestId: "sql-schema",
      toolId: tool.id,
      operation: "describe_schema",
      argumentsJson: JSON.stringify({ schema: "public", table: "orders", maxRows: 25 }),
      purpose: "Inspecionar o schema autorizado.",
    });
    assert.equal(schema.status, "success");
    assert.match(postgresRequests.at(-1)?.query ?? "", /FROM information_schema\.columns/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /table_schema = 'public'/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /table_name = 'orders'/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /LIMIT 25$/);

    postgresFailure = new Error(
      "Conexão recusada para database-password; password=database-password",
    );
    const failed = await executor.execute({
      requestId: "sql-failure",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders" }),
      purpose: "Validar erro seguro.",
    });
    assert.equal(failed.status, "error");
    assert.match(failed.summary, /Conexão recusada/i);
    assert.doesNotMatch(JSON.stringify(failed), /database-password/);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PostgreSQL padrão tenta conexão pelo driver pg sem executar psql", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-postgres-driver-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "postgres_readonly",
    name: "PostgreSQL via driver",
    config: {
      host: "127.0.0.1",
      port: 1,
      database: "threadmark_unavailable",
      username: "threadmark_readonly",
      sslMode: "disable",
    },
    secrets: { password: "driver-password-must-stay-secret" },
    allowedOperations: ["query_readonly"],
  }, "test");
  let commandExecutions = 0;
  const executor = new DeepToolExecutor(service, {
    timeoutMs: 1_000,
    async commandRunner() {
      commandExecutions += 1;
      throw new Error("psql foi executado indevidamente");
    },
  });

  try {
    const connection = await executor.test(tool.id);
    assert.equal(connection.ok, false);
    assert.equal(connection.mode, "connection");
    assert.equal(commandExecutions, 0);
    assert.doesNotMatch(connection.message, /psql foi executado/i);
    assert.doesNotMatch(connection.message, /driver-password-must-stay-secret/);
    assert.equal(service.get(tool.id).lastTestStatus, "failed");
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ClickHouse recebe readonly=2 e nunca expõe a credencial no resultado", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-clickhouse-tool-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "clickhouse_readonly",
    name: "Analytics readonly",
    config: {
      baseUrl: "https://clickhouse.example.test",
      database: "analytics",
      username: "support",
    },
    secrets: { password: "clickhouse-password" },
    allowedOperations: ["query_readonly"],
  }, "test");
  let receivedUrl: URL | null = null;
  let receivedInit: RequestInit | null = null;
  const executor = new DeepToolExecutor(service, {
    fetchImpl: (async (input, init) => {
      receivedUrl = new URL(String(input));
      receivedInit = init ?? null;
      return new Response('{"id":42}\n', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  try {
    const result = await executor.execute({
      requestId: "ch-1",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders", maxRows: 10 }),
      purpose: "Confirmar pedido.",
    });
    assert.equal(result.status, "success");
    const capturedUrl = receivedUrl as URL | null;
    const capturedInit = receivedInit as RequestInit | null;
    assert.equal(capturedUrl?.searchParams.get("readonly"), "2");
    assert.equal(capturedInit?.redirect, "error");
    assert.equal((capturedInit?.headers as Record<string, string>)["x-clickhouse-key"], "clickhouse-password");
    assert.doesNotMatch(JSON.stringify(result), /clickhouse-password/);

    const externalFunction = await executor.execute({
      requestId: "ch-external",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT * FROM s3('https://example.test/data.csv')" }),
      purpose: "Tentar acessar fonte externa.",
    });
    assert.equal(externalFunction.status, "error");
    assert.match(externalFunction.summary, /table function externa/i);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
