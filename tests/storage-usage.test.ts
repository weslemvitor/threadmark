import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import {
  LocalStorageUsageError,
  LocalStorageUsageService,
  measureLocalStorageUsage,
  type LocalStorageUsageOptions,
  type LocalStorageUsageReport,
} from "../server/runtime/storage-usage.js";

test("serviço compartilha uma varredura enquanto outra medição está em andamento", async () => {
  const fixture = await storageFixture();
  try {
    await bytes(fixture.databasePath, 10);
    const service = new LocalStorageUsageService(fixture);
    const first = service.read();
    const second = service.read();
    assert.equal(first, second);
    assert.equal((await first).scan.filesCounted, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("armazenamento soma cada arquivo uma vez, inclui WAL/SHM e não segue symlinks", async () => {
  const fixture = await storageFixture();
  try {
    await Promise.all([
      bytes(fixture.databasePath, 10),
      bytes(`${fixture.databasePath}-wal`, 5),
      bytes(`${fixture.databasePath}-shm`, 3),
      bytes(path.join(fixture.attachmentsDirectory, "nested", "image.png"), 7),
      bytes(path.join(fixture.backupsDirectory, "full", "snapshot.sqlite"), 11),
      bytes(path.join(fixture.logsDirectory, "daemon.log"), 13),
      bytes(path.join(fixture.dataDirectory, "session-backups", "state.json"), 17),
    ]);
    const outside = path.join(fixture.root, "outside.bin");
    await bytes(outside, 1_000);
    await symlink(outside, path.join(fixture.attachmentsDirectory, "outside-link"));

    const result = await measureLocalStorageUsage({
      ...fixture,
      now: new Date("2026-07-18T20:00:00.000Z"),
    });

    const sqliteBytes = await allocatedBytes([
      fixture.databasePath,
      `${fixture.databasePath}-wal`,
      `${fixture.databasePath}-shm`,
    ]);
    const attachmentBytes = await allocatedBytes([
      path.join(fixture.attachmentsDirectory, "nested", "image.png"),
    ]);
    const backupBytes = await allocatedBytes([
      path.join(fixture.backupsDirectory, "full", "snapshot.sqlite"),
    ]);
    const logBytes = await allocatedBytes([
      path.join(fixture.logsDirectory, "daemon.log"),
    ]);
    const otherBytes = await allocatedBytes([
      path.join(fixture.dataDirectory, "session-backups", "state.json"),
    ]);

    assert.equal(result.measuredAt, "2026-07-18T20:00:00.000Z");
    assert.equal(
      result.totalBytes,
      sqliteBytes + attachmentBytes + backupBytes + logBytes + otherBytes,
    );
    assert.deepEqual(result.components, {
      sqlite: { bytes: sqliteBytes, files: 3 },
      attachments: { bytes: attachmentBytes, files: 1 },
      backups: { bytes: backupBytes, files: 1 },
      logs: { bytes: logBytes, files: 1 },
      other: { bytes: otherBytes, files: 1 },
    });
    assert.equal(result.scan.filesCounted, 7);
    assert.equal(result.scan.skippedSymlinks, 1);
    assert.equal(result.scan.truncated, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("armazenamento aplica limites e rejeita raiz simbólica sem expor caminhos", async () => {
  const fixture = await storageFixture();
  try {
    await Promise.all([
      bytes(path.join(fixture.dataDirectory, "one"), 1),
      bytes(path.join(fixture.dataDirectory, "two"), 1),
    ]);
    const limited = await measureLocalStorageUsage({ ...fixture, maxEntries: 1 });
    assert.equal(limited.scan.truncated, true);
    assert.ok(limited.scan.entriesVisited <= 1);

    const linkedRoot = path.join(fixture.root, "linked-data");
    await symlink(fixture.dataDirectory, linkedRoot);
    await assert.rejects(
      measureLocalStorageUsage({
        ...fixture,
        dataDirectory: linkedRoot,
        databasePath: path.join(linkedRoot, "threadmark.sqlite"),
        attachmentsDirectory: path.join(linkedRoot, "attachments"),
        backupsDirectory: path.join(linkedRoot, "backups"),
        logsDirectory: path.join(linkedRoot, "logs"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof LocalStorageUsageError);
        assert.doesNotMatch(error.message, new RegExp(fixture.root));
        assert.match(error.message, /link simbólico/);
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("API de armazenamento exige serviço e devolve somente métricas", async () => {
  const database = createDatabase(":memory:");
  try {
    const report = sampleReport();
    const app = createTestApiApp(
      new SupportStore(database),
      undefined,
      undefined,
      { storageUsage: { async read() { return report; } } },
    );
    const response = await app.request("/api/settings/storage");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), report);
    assert.doesNotMatch(JSON.stringify(report), /Users|\.data|threadmark\.sqlite/);
  } finally {
    database.close();
  }
});

test("API de armazenamento não expõe detalhes de falhas do filesystem", async () => {
  const database = createDatabase(":memory:");
  try {
    const app = createTestApiApp(
      new SupportStore(database),
      undefined,
      undefined,
      {
        storageUsage: {
          async read() {
            throw new Error("EACCES /Users/private/.data/live");
          },
        },
      },
    );
    const response = await app.request("/api/settings/storage");
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.match(body, /Não foi possível medir o armazenamento local/);
    assert.doesNotMatch(body, /EACCES|Users|\.data/);
  } finally {
    database.close();
  }
});

interface StorageFixture extends LocalStorageUsageOptions {
  root: string;
}

async function storageFixture(): Promise<StorageFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-storage-"));
  const dataDirectory = path.join(root, "data");
  const fixture = {
    root,
    dataDirectory,
    databasePath: path.join(dataDirectory, "threadmark.sqlite"),
    attachmentsDirectory: path.join(dataDirectory, "attachments"),
    backupsDirectory: path.join(dataDirectory, "backups"),
    logsDirectory: path.join(dataDirectory, "logs"),
  };
  await Promise.all([
    mkdir(fixture.attachmentsDirectory, { recursive: true }),
    mkdir(fixture.backupsDirectory, { recursive: true }),
    mkdir(fixture.logsDirectory, { recursive: true }),
  ]);
  return fixture;
}

async function allocatedBytes(files: string[]): Promise<number> {
  const stats = await Promise.all(files.map((file) => lstat(file)));
  return stats.reduce((total, item) => total + item.blocks * 512, 0);
}

async function bytes(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
}

function sampleReport(): LocalStorageUsageReport {
  return {
    measuredAt: "2026-07-18T20:00:00.000Z",
    totalBytes: 66,
    components: {
      sqlite: { bytes: 18, files: 3 },
      attachments: { bytes: 7, files: 1 },
      backups: { bytes: 11, files: 1 },
      logs: { bytes: 13, files: 1 },
      other: { bytes: 17, files: 1 },
    },
    scan: {
      entriesVisited: 12,
      directoriesVisited: 5,
      filesCounted: 7,
      skippedSymlinks: 1,
      skippedSpecialFiles: 0,
      unreadableEntries: 0,
      truncated: false,
    },
  };
}
