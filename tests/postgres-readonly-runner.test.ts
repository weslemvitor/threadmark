import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { ClientConfig } from "pg";

import {
  createPostgresRunner,
  type PostgresClientLike,
  type PostgresQueryRequest,
} from "../server/tools/postgres-readonly-runner.js";

const baseRequest: PostgresQueryRequest = {
  config: {
    host: "postgres.internal",
    port: 5_432,
    database: "support",
    username: "support_readonly",
    sslMode: "require",
  },
  password: "database-secret",
  query: "SELECT id, note FROM tickets LIMIT 10",
  timeoutMs: 1_000,
  statementTimeoutMs: 700,
  lockTimeoutMs: 300,
  maxOutputBytes: 80_000,
};

function successfulClient(
  content = "id,note\n1,ok\n",
  observations?: { queries: string[]; copies: string[]; ends: number },
): PostgresClientLike {
  return {
    async connect() {},
    async query(sql) {
      observations?.queries.push(sql);
    },
    copyToCsv(sql) {
      observations?.copies.push(sql);
      return Readable.from([Buffer.from(content)]);
    },
    async end() {
      if (observations) observations.ends += 1;
    },
  };
}

test("runner PostgreSQL usa transação readonly e preserva o CSV recebido em streaming", async () => {
  const configs: ClientConfig[] = [];
  const observations = { queries: [] as string[], copies: [] as string[], ends: 0 };
  const csv = 'id,note,missing\r\n1,"vírgula, aspas "" e\nquebra",\r\n';
  const runner = createPostgresRunner({
    clientFactory(config) {
      configs.push(config);
      return successfulClient(csv, observations);
    },
  });

  const result = await runner(baseRequest);

  assert.equal(result, csv.trim());
  assert.deepEqual(observations.queries, [
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = '700ms'",
    "SET LOCAL lock_timeout = '300ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '1000ms'",
    "ROLLBACK",
  ]);
  assert.deepEqual(observations.copies, [
    "COPY (SELECT id, note FROM tickets LIMIT 10) TO STDOUT WITH (FORMAT CSV, HEADER TRUE)",
  ]);
  assert.equal(observations.ends, 1);
  assert.equal(configs[0]?.application_name, "threadmark_readonly");
  assert.equal(configs[0]?.query_timeout, 1_000);
  assert.equal(configs[0]?.statement_timeout, undefined);
  assert.equal(configs[0]?.lock_timeout, undefined);
  assert.equal(configs[0]?.idle_in_transaction_session_timeout, undefined);
  assert.equal(configs[0]?.options, undefined);
  assert.deepEqual(configs[0]?.ssl, { rejectUnauthorized: false });
});

test("runner PostgreSQL mapeia SSL e só faz fallback do prefer quando o servidor não oferece TLS", async () => {
  const expectedSsl = new Map<PostgresQueryRequest["config"]["sslMode"], ClientConfig["ssl"]>([
    ["disable", false],
    ["require", { rejectUnauthorized: false }],
    ["verify-full", { rejectUnauthorized: true }],
  ]);

  for (const [sslMode, expected] of expectedSsl) {
    const configs: ClientConfig[] = [];
    const runner = createPostgresRunner({
      clientFactory(config) {
        configs.push(config);
        return successfulClient();
      },
    });
    await runner({ ...baseRequest, config: { ...baseRequest.config, sslMode } });
    assert.deepEqual(configs.map((config) => config.ssl), [expected]);
  }

  const preferConfigs: ClientConfig[] = [];
  let attempts = 0;
  const preferRunner = createPostgresRunner({
    clientFactory(config) {
      preferConfigs.push(config);
      attempts += 1;
      if (attempts === 1) {
        return {
          ...successfulClient(),
          async connect() {
            throw new Error("The server does not support SSL connections");
          },
        };
      }
      return successfulClient();
    },
  });

  await preferRunner({
    ...baseRequest,
    config: { ...baseRequest.config, sslMode: "prefer" },
  });
  assert.deepEqual(preferConfigs.map((config) => config.ssl), [
    { rejectUnauthorized: false },
    false,
  ]);
});

test("runner PostgreSQL não enfraquece SSL em erro de autenticação e oculta a senha", async () => {
  const configs: ClientConfig[] = [];
  const runner = createPostgresRunner({
    clientFactory(config) {
      configs.push(config);
      return {
        ...successfulClient(),
        async connect() {
          throw new Error("password=database-secret: autenticação recusada");
        },
      };
    },
  });

  await assert.rejects(
    runner({
      ...baseRequest,
      config: { ...baseRequest.config, sslMode: "prefer" },
    }),
    (error: Error) => {
      assert.match(error.message, /password=\[REDACTED\]/);
      assert.doesNotMatch(error.message, /database-secret/);
      return true;
    },
  );
  assert.equal(configs.length, 1);
  assert.deepEqual(configs[0]?.ssl, { rejectUnauthorized: false });
});

test("runner PostgreSQL corta saída acima do limite e fecha COPY sem tentar ROLLBACK", async () => {
  const observations = { queries: [] as string[], copies: [] as string[], ends: 0 };
  const runner = createPostgresRunner({
    clientFactory() {
      return successfulClient(`id\n${"x".repeat(200)}\n`, observations);
    },
  });

  await assert.rejects(
    runner({ ...baseRequest, maxOutputBytes: 32 }),
    /excedeu o limite de saída/i,
  );
  assert.deepEqual(observations.queries, [
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = '700ms'",
    "SET LOCAL lock_timeout = '300ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '1000ms'",
  ]);
  assert.equal(observations.ends, 1);
});

test("runner PostgreSQL aplica deadline wall-clock e encerra conexão pendente", async () => {
  let rejectConnect: ((reason?: unknown) => void) | undefined;
  let ends = 0;
  const keepEventLoopAlive = setInterval(() => undefined, 1_000);
  const runner = createPostgresRunner({
    clientFactory() {
      return {
        connect: () => new Promise<void>((_resolve, reject) => {
          rejectConnect = reject;
        }),
        async query() {},
        copyToCsv() {
          throw new Error("COPY não deveria iniciar.");
        },
        async end() {
          ends += 1;
          rejectConnect?.(new Error("conexão encerrada"));
        },
      };
    },
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runner({ ...baseRequest, timeoutMs: 30 }),
      /excedeu o limite de tempo/i,
    );
  } finally {
    clearInterval(keepEventLoopAlive);
  }
  assert.equal(ends, 1);
  assert.ok(Date.now() - startedAt < 500, "o deadline deve encerrar a conexão imediatamente");
});

test("runner PostgreSQL propaga cancelamento do operador e destrói o stream ativo", async () => {
  const output = new Readable({ read() {} });
  let ends = 0;
  const controller = new AbortController();
  const runner = createPostgresRunner({
    clientFactory() {
      return {
        async connect() {},
        async query() {},
        copyToCsv() {
          return output;
        },
        async end() {
          ends += 1;
        },
      };
    },
  });
  const cancellation = new Error("cancelada pelo operador");
  const pending = runner({ ...baseRequest, signal: controller.signal });
  setImmediate(() => controller.abort(cancellation));

  await assert.rejects(pending, /cancelada pelo operador/i);
  assert.equal(output.destroyed, true);
  assert.equal(ends, 1);
});
