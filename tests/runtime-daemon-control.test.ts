import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectDaemonIdentity,
  requestDaemonShutdown,
  waitForDaemonReady,
  waitForDaemonStopped,
} from "../server/runtime/daemon-control.js";

test("identifica uma API Threadmark somente depois de validar o token local", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url.endsWith("/health")) {
      return Response.json({
        ok: true,
        service: "threadmark-api",
        pid: 4321,
      });
    }
    if (url.endsWith("/api/runtime/identity")) {
      if (headers.get("authorization") !== "Bearer local-secret-token") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        ok: true,
        service: "threadmark-api",
        pid: 4321,
        startedAt: "2026-07-18T12:00:00.000Z",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const unauthenticated = await inspectDaemonIdentity("http://127.0.0.1:4317", {
    token: "wrong-token-with-enough-length-000000",
    fetcher,
  });
  assert.equal(unauthenticated.state, "threadmark");
  assert.equal(
    unauthenticated.state === "threadmark" && unauthenticated.authenticated,
    false,
  );

  const authenticated = await inspectDaemonIdentity("http://127.0.0.1:4317", {
    token: "local-secret-token",
    fetcher,
  });
  assert.equal(authenticated.state, "threadmark");
  assert.equal(
    authenticated.state === "threadmark" && authenticated.authenticated,
    true,
  );
  assert.equal(authenticated.state === "threadmark" && authenticated.pid, 4321);
  assert.equal(
    requests.some((request) => request.authorization === "Bearer local-secret-token"),
    true,
  );
});

test("recusa classificar como Threadmark uma resposta estrangeira na mesma porta", async () => {
  const inspection = await inspectDaemonIdentity("http://127.0.0.1:4317", {
    fetcher: (async () => Response.json({ ok: true, service: "another-app" })) as typeof fetch,
  });
  assert.equal(inspection.state, "foreign");
});

test("prontidão exige health do daemon e assets CSS e JavaScript acessíveis", async () => {
  let healthAttempts = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/health")) {
      healthAttempts += 1;
      if (healthAttempts === 1) throw new TypeError("connection refused");
      return Response.json({
        ok: true,
        service: "threadmark-api",
        pid: 9876,
        startedAt: "2026-07-18T12:00:00.000Z",
      });
    }
    if (url === "http://127.0.0.1:3000/") {
      return new Response(
        '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>',
      );
    }
    if (url.endsWith("/assets/app.css") || url.endsWith("/assets/app.js")) {
      return new Response("asset");
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const identity = await waitForDaemonReady({
    apiUrl: "http://127.0.0.1:4317",
    webOrigin: "http://127.0.0.1:3000",
    webEnabled: true,
    fetcher,
    timeoutMs: 1_000,
    retryIntervalMs: 1,
  });
  assert.equal(identity.pid, 9876);
  assert.equal(healthAttempts, 2);
});

test("shutdown envia token e valida o PID confirmado pelo daemon", async () => {
  let request: { method?: string; authorization: string | null } | null = null;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = {
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    return Response.json(
      { accepted: true, service: "threadmark-api", pid: 2468 },
      { status: 202 },
    );
  }) as typeof fetch;

  await requestDaemonShutdown(
    "http://127.0.0.1:4317",
    "installation-token",
    2468,
    fetcher,
  );
  assert.deepEqual(request, {
    method: "POST",
    authorization: "Bearer installation-token",
  });
  await assert.rejects(
    requestDaemonShutdown(
      "http://127.0.0.1:4317",
      "installation-token",
      9999,
      fetcher,
    ),
    /confirmação de encerramento inconsistente/,
  );
});

test("espera o processo e a API autenticada encerrarem sem enviar sinal", async () => {
  let checks = 0;
  const fetcher = (async () => {
    checks += 1;
    if (checks === 1) {
      return Response.json({ ok: true, service: "threadmark-api", pid: 1357 });
    }
    throw new TypeError("connection refused");
  }) as typeof fetch;

  await waitForDaemonStopped("http://127.0.0.1:4317", 1357, {
    fetcher,
    processRunning: () => checks < 2,
    timeoutMs: 1_000,
    retryIntervalMs: 1,
  });
  assert.equal(checks, 2);
});
