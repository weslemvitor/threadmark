import assert from "node:assert/strict";
import test from "node:test";

import { SetupChallengeService } from "../server/auth/setup-challenge.js";
import { createDatabase } from "../server/db/index.js";

test("código de bootstrap fica somente como hash, expira e é de uso único", () => {
  const database = createDatabase(":memory:");
  let now = new Date("2026-07-18T12:00:00.000Z");
  try {
    const service = new SetupChallengeService(database, () => now);
    const issued = service.issue(60_000);
    const stored = database
      .prepare("SELECT token_hash FROM local_setup_challenges")
      .get() as { token_hash: string };
    assert.notEqual(stored.token_hash, issued.token);
    assert.equal(service.hasActive(), true);
    service.assertValid(issued.token);
    assert.throws(() => service.assertValid("incorreto"), /inválido ou expirou/);
    service.consume();
    assert.equal(service.hasActive(), false);
    assert.throws(() => service.assertValid(issued.token), /inválido ou expirou/);

    const rotated = service.issue(60_000);
    now = new Date("2026-07-18T12:02:00.000Z");
    assert.throws(() => service.assertValid(rotated.token), /inválido ou expirou/);
  } finally {
    database.close();
  }
});
