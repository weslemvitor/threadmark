import assert from "node:assert/strict";
import test from "node:test";

import { LocalAuthService } from "../server/auth/index.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp } from "../server/index.js";

test("API emite credencial headless, limita rotas e permite revogação", async () => {
  const database = createDatabase(":memory:");
  try {
    const auth = new LocalAuthService(database);
    const setup = await auth.bootstrapSetup({
      organizationName: "Acme",
      workspaceName: "Suporte",
      timezone: "America/Sao_Paulo",
      username: "weslem",
      displayName: "Weslem",
      password: "senha-segura-123",
    });
    const app = createApiApp(new SupportStore(database), undefined, undefined, { auth });
    const cookie = `threadmark_session=${setup.token}`;

    const issuedResponse = await app.request("/api/integration-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "CLI no Mac",
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    });
    assert.equal(issuedResponse.status, 201);
    assert.equal(issuedResponse.headers.get("cache-control"), "no-store");
    const issued = (await issuedResponse.json()) as {
      token: string;
      credential: { id: string; userId: string; scope: string; clientId: string };
    };
    assert.match(issued.token, /^tmk_/);
    assert.equal(issued.credential.userId, setup.user.id);
    assert.equal(issued.credential.scope, "headless");
    assert.equal(issued.credential.clientId, "threadmark-cli");

    const listedResponse = await app.request("/api/integration-credentials", {
      headers: { cookie },
    });
    assert.equal(listedResponse.status, 200);
    const listedText = await listedResponse.text();
    assert.equal(listedText.includes(issued.token), false);
    assert.equal((JSON.parse(listedText) as { items: unknown[] }).items.length, 1);

    const integrationHeaders = {
      authorization: `Bearer ${issued.token}`,
    };
    const allowed = await app.request("/api/ticket-assignees", {
      headers: integrationHeaders,
    });
    assert.equal(allowed.status, 200);

    const current = await app.request("/api/integration-credentials/current", {
      headers: integrationHeaders,
    });
    assert.equal(current.status, 200);
    assert.equal(
      ((await current.json()) as { credential: { id: string } }).credential.id,
      issued.credential.id,
    );

    const forbiddenRuntime = await app.request("/api/runtime", {
      headers: integrationHeaders,
    });
    assert.equal(forbiddenRuntime.status, 403);
    const forbiddenSettings = await app.request("/api/settings/workspace", {
      headers: integrationHeaders,
    });
    assert.equal(forbiddenSettings.status, 403);
    for (const [method, route] of [
      ["PUT", "/api/triage/settings"],
      ["DELETE", "/api/tickets/ticket-id"],
      ["PUT", "/api/clients/client-id"],
    ] as const) {
      const forbiddenMutation = await app.request(route, {
        method,
        headers: { ...integrationHeaders, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(forbiddenMutation.status, 403, `${method} ${route}`);
    }
    const forbiddenPrefixRoute = await app.request("/api/tickets/not-headless/messages", {
      headers: integrationHeaders,
    });
    assert.equal(forbiddenPrefixRoute.status, 403);
    const allowedHeadlessMutation = await app.request("/api/tickets", {
      method: "POST",
      headers: { ...integrationHeaders, "content-type": "application/json" },
      body: "{}",
    });
    assert.notEqual(allowedHeadlessMutation.status, 403);
    const mismatchedActor = await app.request("/api/ticket-assignees", {
      headers: {
        ...integrationHeaders,
        "x-threadmark-actor-id": "outro-usuario",
      },
    });
    assert.equal(mismatchedActor.status, 403);
    database.prepare("UPDATE integration_credentials SET client_id = 'hermes' WHERE id = ?")
      .run(issued.credential.id);
    for (const client of ["threadmark-cli", "hermes", "codex"]) {
      const sameCredential = await app.request("/api/ticket-assignees", {
        headers: { ...integrationHeaders, "x-threadmark-agent-client": client },
      });
      assert.equal(sameCredential.status, 200, client);
    }

    const claim = await app.request("/api/agent/triage/jobs/claim", {
      method: "POST",
      headers: { ...integrationHeaders, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { job: null });

    const revoked = await app.request("/api/integration-credentials/current", {
      method: "DELETE",
      headers: integrationHeaders,
    });
    assert.equal(revoked.status, 200);
    const deniedAfterRevoke = await app.request("/api/ticket-assignees", {
      headers: integrationHeaders,
    });
    assert.equal(deniedAfterRevoke.status, 401);
  } finally {
    database.close();
  }
});
