import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";

test("SQLite e arquivos WAL locais usam permissão 0600", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-database-mode-"));
  const databasePath = path.join(temporary, "data", "support.sqlite");
  const database = createDatabase(databasePath);

  try {
    database.exec(`
      CREATE TABLE permission_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO permission_probe (value) VALUES ('ok');
    `);

    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, 0o700);
    assert.equal((await stat(`${databasePath}-wal`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${databasePath}-shm`)).mode & 0o777, 0o600);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
