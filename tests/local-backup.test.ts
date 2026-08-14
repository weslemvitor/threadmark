import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createDatabase, migrations } from "../server/db/index.js";
import {
  createLocalBackup,
  listLocalBackups,
  pruneLocalBackups,
  restoreLocalBackup,
  validateLocalBackup,
  type LocalBackupResult,
} from "../server/runtime/backup.js";

test("backup rápido cria snapshot SQLite, configurações e manifesto sem dados privados", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.settingsPath, '{"workspace":"Acme"}\n');
    const result = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      settingsPath: fixture.settingsPath,
      label: "manual",
      now: new Date("2026-07-18T12:00:00.000Z"),
    });

    assert.equal(result.mode, "quick");
    assert.equal(result.attachmentsIncluded, false);
    assert.equal(result.settingsIncluded, true);
    assert.equal((await stat(result.databasePath)).isFile(), true);
    assert.equal(await readFile(path.join(result.directory, "settings.json"), "utf8"), '{"workspace":"Acme"}\n');
    assert.deepEqual(readProbe(result.databasePath), { value: "preservado" });
    const manifest = await readFile(path.join(result.directory, "manifest.json"), "utf8");
    assert.match(manifest, /threadmark-local-backup/);
    assert.match(manifest, /"version": 2/);
    assert.match(manifest, /"sha256"/);
    assert.match(manifest, /"secrets": false/);
    assert.match(manifest, /"whatsappAuth": false/);
    assert.doesNotMatch(manifest, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fixture.dispose();
  }
});

test("backup completo inclui anexos, mas nunca auth ou cofre de segredos", async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.attachmentsDirectory, { recursive: true });
    await writeFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "imagem");
    await mkdir(path.join(fixture.dataDirectory, "whatsapp-auth"));
    await writeFile(path.join(fixture.dataDirectory, "whatsapp-auth", "creds.json"), "segredo");
    await mkdir(path.join(fixture.dataDirectory, "secrets"));
    await writeFile(path.join(fixture.dataDirectory, "secrets", "provider.json"), "segredo");

    const result = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      settingsPath: fixture.settingsPath,
      attachmentsDirectory: fixture.attachmentsDirectory,
      mode: "full",
    });

    assert.equal(result.attachmentsIncluded, true);
    assert.equal(
      await readFile(path.join(result.directory, "attachments", "evidence.txt"), "utf8"),
      "imagem",
    );
    const files = result.manifest.files.map((file) => file.path);
    assert.equal(files.some((file) => file.includes("whatsapp-auth")), false);
    assert.equal(files.some((file) => file.includes("secrets")), false);
  } finally {
    await fixture.dispose();
  }
});

test("validação detecta corrupção de conteúdo", async () => {
  const fixture = await createFixture();
  try {
    const result = await backupFixture(fixture);
    await writeFile(path.join(result.directory, "settings.json"), '{"adulterado":true}\n');
    await assert.rejects(
      validateLocalBackup({ directory: result.directory }),
      /Tamanho divergente|Checksum divergente/,
    );
    const listed = await listLocalBackups({ backupsDirectory: fixture.backupsDirectory });
    assert.equal(listed[0]?.valid, false);
  } finally {
    await fixture.dispose();
  }
});

test("validação recusa traversal declarado no manifesto", async () => {
  const fixture = await createFixture();
  try {
    const result = await backupFixture(fixture);
    const manifestPath = path.join(result.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    manifest.files.push({ path: "../escape", size: 0, sha256: "0".repeat(64) });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      validateLocalBackup({ directory: result.directory }),
      /Caminho inseguro/,
    );
  } finally {
    await fixture.dispose();
  }
});

test("restore completo usa staging, cria safety backup e repõe banco, settings e anexos", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.settingsPath, '{"state":"old"}\n');
    await mkdir(fixture.attachmentsDirectory, { recursive: true });
    await writeFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "old");
    const source = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      settingsPath: fixture.settingsPath,
      attachmentsDirectory: fixture.attachmentsDirectory,
      mode: "full",
      label: "restore-source",
    });
    setProbe(fixture.database, "current");
    await writeFile(fixture.settingsPath, '{"state":"current"}\n');
    await writeFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "current");
    fixture.database.close();

    const restored = await restoreFixture(fixture, source);

    assert.ok(restored.safetyBackup);
    assert.equal(restored.safetyBackup.kind, "safety");
    assert.deepEqual(readProbe(fixture.databasePath), { value: "preservado" });
    assert.equal(await readFile(fixture.settingsPath, "utf8"), '{"state":"old"}\n');
    assert.equal(await readFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "utf8"), "old");
    assert.deepEqual(readProbe(restored.safetyBackup.databasePath), { value: "current" });
    assert.equal(await readFile(path.join(restored.safetyBackup.directory, "settings.json"), "utf8"), '{"state":"current"}\n');
  } finally {
    await fixture.dispose();
  }
});

test("falha durante restore faz rollback integral do estado anterior", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.settingsPath, '{"state":"old"}\n');
    await mkdir(fixture.attachmentsDirectory, { recursive: true });
    await writeFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "old");
    const source = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      settingsPath: fixture.settingsPath,
      attachmentsDirectory: fixture.attachmentsDirectory,
      mode: "full",
    });
    setProbe(fixture.database, "must-survive");
    await writeFile(fixture.settingsPath, '{"state":"must-survive"}\n');
    await writeFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "must-survive");
    fixture.database.close();

    await assert.rejects(
      restoreFixture(fixture, source, {
        onStep(step) {
          if (step === "database-applied") throw new Error("falha injetada");
        },
      }),
      /falha injetada/,
    );

    assert.deepEqual(readProbe(fixture.databasePath), { value: "must-survive" });
    assert.equal(await readFile(fixture.settingsPath, "utf8"), '{"state":"must-survive"}\n');
    assert.equal(
      await readFile(path.join(fixture.attachmentsDirectory, "evidence.txt"), "utf8"),
      "must-survive",
    );
  } finally {
    await fixture.dispose();
  }
});

test("falha de retenção após restore não apaga o estado já restaurado", async () => {
  const fixture = await createFixture();
  let permissionsRestricted = false;
  const originalWarn = console.warn;
  try {
    await writeFile(fixture.settingsPath, '{"state":"backup"}\n');
    const source = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      settingsPath: fixture.settingsPath,
    });
    setProbe(fixture.database, "current");
    await writeFile(fixture.settingsPath, '{"state":"current"}\n');
    fixture.database.close();
    console.warn = () => undefined;

    const restored = await restoreFixture(fixture, source, {
      retention: { quick: 1 },
      async onStep(step) {
        if (step === "settings-applied") {
          await chmod(fixture.backupsDirectory, 0o000);
          permissionsRestricted = true;
        }
      },
    });

    assert.equal(restored.backupId, source.id);
    assert.deepEqual(readProbe(fixture.databasePath), { value: "preservado" });
    assert.equal(await readFile(fixture.settingsPath, "utf8"), '{"state":"backup"}\n');
  } finally {
    console.warn = originalWarn;
    if (permissionsRestricted) await chmod(fixture.backupsDirectory, 0o700);
    await fixture.dispose();
  }
});

test("restore é recusado enquanto o daemon está ativo", async () => {
  const fixture = await createFixture();
  try {
    const source = await backupFixture(fixture);
    fixture.database.close();
    await writeFile(fixture.pidPath, `${process.pid}\n`);
    await assert.rejects(restoreFixture(fixture, source), /ainda está em execução/);
  } finally {
    await fixture.dispose();
  }
});

test("retenção é configurável por modo e preserva backups corrompidos para inspeção", async () => {
  const fixture = await createFixture();
  try {
    const first = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    const second = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      now: new Date("2026-07-16T10:00:00.000Z"),
    });
    const third = await createLocalBackup({
      database: fixture.database,
      backupsDirectory: fixture.backupsDirectory,
      now: new Date("2026-07-17T10:00:00.000Z"),
    });
    const corruptDirectory = path.join(fixture.backupsDirectory, "corrupt-import");
    await mkdir(corruptDirectory);
    await writeFile(path.join(corruptDirectory, "manifest.json"), "not-json");

    const result = await pruneLocalBackups({
      backupsDirectory: fixture.backupsDirectory,
      retention: { quick: 2 },
    });

    assert.deepEqual(result.deleted, [first.id]);
    assert.deepEqual(new Set(result.kept), new Set([third.id, second.id]));
    await assert.rejects(stat(first.directory), { code: "ENOENT" });
    assert.equal((await stat(corruptDirectory)).isDirectory(), true);
  } finally {
    await fixture.dispose();
  }
});

test("createDatabase cria snapshot verificável antes de migrações pendentes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-pre-migration-"));
  const databasePath = path.join(root, "threadmark.sqlite");
  const backupsDirectory = path.join(root, "backups");
  const settingsPath = path.join(root, "settings.json");
  const oldDatabase = new Database(databasePath);
  try {
    oldDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations.filter((item) => item.version <= 20)) {
      oldDatabase.transaction(() => {
        oldDatabase.exec(migration.sql);
        oldDatabase
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, "2026-07-18T10:00:00.000Z");
      })();
    }
  } finally {
    oldDatabase.close();
  }
  await writeFile(settingsPath, '{"workspace":"before-migration"}\n');

  const migrated = createDatabase(databasePath, {
    preMigrationBackupsDirectory: backupsDirectory,
    settingsPath,
    preMigrationRetention: 2,
  });
  try {
    const current = migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    assert.equal(current.version, migrations.at(-1)?.version);
  } finally {
    migrated.close();
  }

  try {
    const backups = await listLocalBackups({ backupsDirectory });
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.valid, true);
    assert.equal(backups[0]?.kind, "pre-migration");
    const manifest = await validateLocalBackup({ directory: backups[0]!.directory });
    assert.deepEqual(manifest.migration, {
      fromVersion: 20,
      toVersion: migrations.at(-1)?.version,
    });
    const snapshot = new Database(path.join(backups[0]!.directory, "threadmark.sqlite"), {
      readonly: true,
    });
    try {
      const previous = snapshot.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      assert.equal(previous.version, 20);
    } finally {
      snapshot.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  dataDirectory: string;
  databasePath: string;
  backupsDirectory: string;
  settingsPath: string;
  attachmentsDirectory: string;
  pidPath: string;
  database: ReturnType<typeof createDatabase>;
  dispose(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-backup-"));
  const dataDirectory = path.join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, "threadmark.sqlite");
  const database = createDatabase(databasePath);
  database.exec("CREATE TABLE backup_probe (value TEXT NOT NULL)");
  database.prepare("INSERT INTO backup_probe (value) VALUES (?)").run("preservado");
  return {
    root,
    dataDirectory,
    databasePath,
    backupsDirectory: path.join(dataDirectory, "backups"),
    settingsPath: path.join(dataDirectory, "settings.json"),
    attachmentsDirectory: path.join(dataDirectory, "attachments"),
    pidPath: path.join(dataDirectory, "threadmark.pid"),
    database,
    async dispose() {
      if (database.open) database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function backupFixture(fixture: Fixture): Promise<LocalBackupResult> {
  await writeFile(fixture.settingsPath, '{"workspace":"Acme"}\n');
  return createLocalBackup({
    database: fixture.database,
    backupsDirectory: fixture.backupsDirectory,
    settingsPath: fixture.settingsPath,
  });
}

async function restoreFixture(
  fixture: Fixture,
  backup: LocalBackupResult,
  extra: Pick<Parameters<typeof restoreLocalBackup>[0], "onStep" | "retention"> = {},
) {
  return restoreLocalBackup({
    backupDirectory: backup.directory,
    databasePath: fixture.databasePath,
    settingsPath: fixture.settingsPath,
    attachmentsDirectory: fixture.attachmentsDirectory,
    backupsDirectory: fixture.backupsDirectory,
    pidPath: fixture.pidPath,
    ...extra,
  });
}

function setProbe(database: ReturnType<typeof createDatabase>, value: string): void {
  database.prepare("UPDATE backup_probe SET value = ?").run(value);
}

function readProbe(databasePath: string): { value: string } | undefined {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT value FROM backup_probe").get() as
      | { value: string }
      | undefined;
  } finally {
    database.close();
  }
}
