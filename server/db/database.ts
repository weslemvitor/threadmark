import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import { loadConfig } from "../runtime/config.js";
import { createPreMigrationBackupSync } from "../runtime/backup.js";
import { migrations } from "./schema.js";

export type SupportDatabase = Database.Database;

export interface CreateDatabaseOptions {
  automaticPreMigrationBackup?: boolean;
  preMigrationBackupsDirectory?: string;
  settingsPath?: string;
  preMigrationRetention?: number;
}

export function resolveDatabasePath(path = process.env.SUPPORT_DB_PATH): string {
  return path?.trim() || loadConfig().databasePath;
}

export function createDatabase(
  databasePath = resolveDatabasePath(),
  options: CreateDatabaseOptions = {},
): SupportDatabase {
  const existingDatabase =
    databasePath !== ":memory:" &&
    existsSync(databasePath) &&
    statSync(databasePath).size > 0;
  if (databasePath !== ":memory:") {
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const database = new Database(databasePath);
  hardenDatabaseFiles(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    hardenDatabaseFiles(databasePath);
  }

  try {
    if (
      databasePath !== ":memory:" &&
      existingDatabase &&
      options.automaticPreMigrationBackup !== false
    ) {
      const appliedVersions = readAppliedMigrationVersions(database);
      const pending = migrations.filter(
        (migration) => !appliedVersions.has(migration.version),
      );
      if (pending.length) {
        const fromVersion = Math.max(0, ...appliedVersions);
        createPreMigrationBackupSync({
          database,
          databasePath,
          backupsDirectory:
            options.preMigrationBackupsDirectory ?? join(dirname(databasePath), "backups"),
          settingsPath:
            options.settingsPath ?? join(dirname(databasePath), "settings.json"),
          fromVersion,
          toVersion: Math.max(...pending.map((migration) => migration.version)),
          retention: options.preMigrationRetention,
        });
      }
    }
    migrateDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }
  hardenDatabaseFiles(databasePath);
  return database;
}

function hardenDatabaseFiles(path: string): void {
  if (path === ":memory:") return;
  for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(databaseFile)) chmodSync(databaseFile, 0o600);
  }
}

export function migrateDatabase(database: SupportDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedVersions = readAppliedMigrationVersions(database);

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

function readAppliedMigrationVersions(database: SupportDatabase): Set<number> {
  const migrationsTable = database
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { found: number } | undefined;
  if (!migrationsTable) return new Set();
  return new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
}
