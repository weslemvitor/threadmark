import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hardenPrivateState } from "../server/runtime/private-state.js";

test("endurecimento local aplica 0700/0600 e não segue links simbólicos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-private-"));
  const nested = path.join(root, "backups");
  const secret = path.join(nested, "support.sqlite");
  const outside = path.join(os.tmpdir(), `threadmark-outside-${process.pid}`);
  try {
    await mkdir(nested, { mode: 0o755 });
    await writeFile(secret, "private", { mode: 0o644 });
    await writeFile(outside, "outside", { mode: 0o644 });
    await symlink(outside, path.join(root, "outside-link"));
    await chmod(root, 0o755);

    const result = await hardenPrivateState(root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.equal((await stat(outside)).mode & 0o777, 0o644);
    assert.equal(result.skippedSymlinks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
