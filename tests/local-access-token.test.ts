import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAccessToken } from "../server/auth/local-access-token.js";

test("token local é persistente, restrito e validado sem comparação textual", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-token-"));
  try {
    const filePath = path.join(root, "local-access.token");
    const first = new LocalAccessToken(filePath);
    const token = await first.ensure();
    const second = new LocalAccessToken(filePath);
    assert.equal(await second.ensure(), token);
    assert.equal(await second.verify(token), true);
    assert.equal(await second.verify(`${token}x`), false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
