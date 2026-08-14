import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAuthService } from "../server/auth/index.js";
import { LocalAccessToken } from "../server/auth/local-access-token.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp, createTestApiApp } from "../server/index.js";
import { offlineRuntimeState } from "../server/runtime/runtime-state.js";

test("API de controle exige token local e agenda shutdown controlado", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-control-api-"));
  const database = createDatabase(":memory:");
  const tokenService = new LocalAccessToken(path.join(root, "local-access.token"));
  const token = await tokenService.ensure();
  let shutdownReason: string | null = null;
  const app = createApiApp(
    new SupportStore(database),
    {
      async read() {
        return {
          ...offlineRuntimeState(),
          phase: "starting" as const,
          pid: process.pid,
          startedAt: "2026-07-18T12:00:00.000Z",
        };
      },
    },
    undefined,
    {
      auth: new LocalAuthService(database),
      localAccessToken: tokenService,
      requestShutdown(reason) {
        shutdownReason = reason;
      },
    },
  );

  try {
    const health = await app.request("/health");
    assert.equal(health.status, 200);
    const healthPayload = (await health.json()) as { pid: number; service: string };
    assert.equal(healthPayload.pid, process.pid);
    assert.equal(healthPayload.service, "threadmark-api");

    const unauthorized = await app.request("/api/runtime/identity");
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${token}` };
    const identity = await app.request("/api/runtime/identity", { headers });
    assert.equal(identity.status, 200);
    assert.equal(((await identity.json()) as { pid: number }).pid, process.pid);

    const shutdown = await app.request("/api/runtime/shutdown", {
      method: "POST",
      headers,
    });
    assert.equal(shutdown.status, 202);
    assert.equal(
      ((await shutdown.json()) as { accepted: boolean }).accepted,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shutdownReason, "API local autenticada");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("renovação do QR exige administrador e aciona somente o controlador do WhatsApp", async () => {
  const database = createDatabase(":memory:");
  let renewals = 0;
  const app = createTestApiApp(
    new SupportStore(database),
    {
      async read() {
        return offlineRuntimeState();
      },
    },
    undefined,
    {
      whatsappQrController: {
        async renewQr() {
          renewals += 1;
        },
      },
    },
  );

  try {
    const response = await app.request("/api/runtime/qr/renew", {
      method: "POST",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(renewals, 1);
  } finally {
    database.close();
  }
});
