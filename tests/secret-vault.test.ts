import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSecretVault } from "../server/runtime/secret-vault.js";

test("cofre local cifra, recupera e remove segredos sem texto puro no disco", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadmark-vault-"));
  try {
    const vault = new LocalSecretVault(directory);
    await vault.set("provider:openai", "sk-segredo-de-teste");

    assert.equal(await vault.get("provider:openai"), "sk-segredo-de-teste");
    const encrypted = await readFile(path.join(directory, "secrets.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /sk-segredo-de-teste/);
    assert.equal((await stat(path.join(directory, "secrets.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, "secrets.enc.json"))).mode & 0o777, 0o600);

    assert.equal(await vault.delete("provider:openai"), true);
    assert.equal(await vault.get("provider:openai"), null);
    assert.equal(await vault.delete("provider:openai"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
