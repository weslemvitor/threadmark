import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import type { SupportDatabase } from "../db/database.js";

export const LOCAL_BACKUP_FORMAT = "threadmark-local-backup";
export const LOCAL_BACKUP_VERSION = 2;

export type LocalBackupMode = "quick" | "full";
export type LocalBackupKind = "manual" | "scheduled" | "safety" | "pre-migration";

export interface BackupRetentionPolicy {
  quick?: number;
  full?: number;
  safety?: number;
  preMigration?: number;
}

export const DEFAULT_LOCAL_BACKUP_RETENTION = {
  quick: 7,
  full: 4,
  safety: 3,
  preMigration: 5,
} as const satisfies BackupRetentionPolicy;

export interface LocalBackupOptions {
  database: SupportDatabase;
  backupsDirectory: string;
  settingsPath?: string;
  attachmentsDirectory?: string;
  mode?: LocalBackupMode;
  /** @deprecated Prefer mode: "full". Kept for the existing CLI contract. */
  includeAttachments?: boolean;
  kind?: Exclude<LocalBackupKind, "pre-migration">;
  label?: string;
  now?: Date;
  retention?: BackupRetentionPolicy;
}

export interface BackupFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface LocalBackupManifest {
  format: typeof LOCAL_BACKUP_FORMAT;
  version: typeof LOCAL_BACKUP_VERSION;
  id: string;
  createdAt: string;
  mode: LocalBackupMode;
  kind: LocalBackupKind;
  label?: string;
  sourceSchemaVersion: number;
  migration?: {
    fromVersion: number;
    toVersion: number;
  };
  components: {
    database: true;
    settings: boolean;
    attachments: boolean;
    secrets: false;
    whatsappAuth: false;
  };
  files: BackupFileEntry[];
}

export interface LocalBackupResult {
  id: string;
  directory: string;
  databasePath: string;
  mode: LocalBackupMode;
  kind: LocalBackupKind;
  settingsIncluded: boolean;
  attachmentsIncluded: boolean;
  createdAt: string;
  manifest: LocalBackupManifest;
}

export interface ValidateLocalBackupOptions {
  directory: string;
}

export interface ListedLocalBackup {
  id: string;
  directory: string;
  createdAt: string | null;
  mode: LocalBackupMode | null;
  kind: LocalBackupKind | null;
  valid: boolean;
  error?: string;
  size: number;
}

export interface ListLocalBackupsOptions {
  backupsDirectory: string;
  verifyIntegrity?: boolean;
}

export interface PruneLocalBackupsOptions {
  backupsDirectory: string;
  retention: BackupRetentionPolicy;
}

export interface PruneLocalBackupsResult {
  deleted: string[];
  kept: string[];
}

export type RestoreStep =
  | "staged"
  | "safety-backup-created"
  | "database-applied"
  | "settings-applied"
  | "attachments-applied";

export interface RestoreLocalBackupOptions {
  backupDirectory: string;
  databasePath: string;
  settingsPath: string;
  attachmentsDirectory: string;
  backupsDirectory: string;
  pidPath: string;
  now?: Date;
  retention?: BackupRetentionPolicy;
  /** Useful for lifecycle telemetry and deterministic failure-injection tests. */
  onStep?: (step: RestoreStep) => void | Promise<void>;
}

export interface RestoreLocalBackupResult {
  backupId: string;
  mode: LocalBackupMode;
  restoredAt: string;
  safetyBackup: LocalBackupResult | null;
}

export interface PreMigrationBackupOptions {
  database: SupportDatabase;
  databasePath: string;
  backupsDirectory: string;
  settingsPath?: string;
  fromVersion: number;
  toVersion: number;
  now?: Date;
  retention?: number;
}

/** Creates an atomic, checksummed SQLite/settings snapshot and optionally attachments. */
export async function createLocalBackup(
  options: LocalBackupOptions,
): Promise<LocalBackupResult> {
  const mode = options.mode ?? (options.includeAttachments ? "full" : "quick");
  const kind = options.kind ?? "manual";
  const createdAt = (options.now ?? new Date()).toISOString();
  const id = backupId(createdAt, options.label);
  const directory = path.join(options.backupsDirectory, id);
  const stagingDirectory = path.join(options.backupsDirectory, `.staging-${id}`);
  const databasePath = path.join(stagingDirectory, "threadmark.sqlite");
  const settingsPath = options.settingsPath ?? inferSettingsPath(options.database);

  await mkdir(options.backupsDirectory, { recursive: true, mode: 0o700 });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });

  try {
    await options.database.backup(databasePath);
    await chmod(databasePath, 0o600);

    const settingsIncluded = settingsPath
      ? await copyOptionalRegularFile(settingsPath, path.join(stagingDirectory, "settings.json"))
      : false;
    const attachmentsIncluded =
      mode === "full" && options.attachmentsDirectory
        ? await copyOptionalDirectory(
            options.attachmentsDirectory,
            path.join(stagingDirectory, "attachments"),
          )
        : false;

    const manifest = await createManifest({
      directory: stagingDirectory,
      id,
      createdAt,
      mode,
      kind,
      label: cleanLabel(options.label),
      sourceSchemaVersion: readSchemaVersion(options.database),
      settingsIncluded,
      attachmentsIncluded,
    });
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await validateLocalBackup({ directory: stagingDirectory });
    await rename(stagingDirectory, directory);

    const result: LocalBackupResult = {
      id,
      directory,
      databasePath: path.join(directory, "threadmark.sqlite"),
      mode,
      kind,
      settingsIncluded,
      attachmentsIncluded,
      createdAt,
      manifest,
    };
    if (options.retention) {
      await pruneLocalBackups({
        backupsDirectory: options.backupsDirectory,
        retention: options.retention,
      });
    }
    return result;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Reads and validates a v2 manifest, every checksum, SQLite integrity, and path safety. */
export async function validateLocalBackup(
  options: ValidateLocalBackupOptions,
): Promise<LocalBackupManifest> {
  const root = path.resolve(options.directory);
  const manifestPath = path.join(root, "manifest.json");
  const manifestStats = await stat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.size > 1024 * 1024) {
    throw new Error("Manifesto de backup ausente, inválido ou grande demais.");
  }

  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = parseManifest(parsed);
  const expectedPaths = new Set<string>();
  for (const entry of manifest.files) {
    const relative = validateManifestRelativePath(entry.path);
    if (expectedPaths.has(relative)) {
      throw new Error(`Manifesto contém caminho duplicado: ${relative}`);
    }
    expectedPaths.add(relative);
    validateComponentPath(relative, manifest.mode);
    const absolute = resolveInside(root, relative);
    const fileStats = await lstat(absolute);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error(`Backup contém arquivo inválido ou link simbólico: ${relative}`);
    }
    if (fileStats.size !== entry.size) {
      throw new Error(`Tamanho divergente no backup: ${relative}`);
    }
    if ((await sha256File(absolute)) !== entry.sha256) {
      throw new Error(`Checksum divergente no backup: ${relative}`);
    }
  }

  const actualPaths = new Set(
    (await listRegularFiles(root)).filter((relative) => relative !== "manifest.json"),
  );
  if (!sameSet(expectedPaths, actualPaths)) {
    throw new Error("Conteúdo do backup não corresponde ao manifesto.");
  }
  if (!expectedPaths.has("threadmark.sqlite")) {
    throw new Error("Backup não contém o banco SQLite.");
  }
  if (manifest.components.settings !== expectedPaths.has("settings.json")) {
    throw new Error("Componente de configurações diverge do manifesto.");
  }
  const hasAttachmentFiles = [...expectedPaths].some((item) => item.startsWith("attachments/"));
  if (!manifest.components.attachments && hasAttachmentFiles) {
    throw new Error("Manifesto exclui anexos, mas o backup contém arquivos de anexos.");
  }
  const attachmentsPath = path.join(root, "attachments");
  if (manifest.components.attachments) {
    const attachmentStats = await lstat(attachmentsPath);
    if (!attachmentStats.isDirectory() || attachmentStats.isSymbolicLink()) {
      throw new Error("Diretório de anexos inválido no backup.");
    }
  } else {
    try {
      await lstat(attachmentsPath);
      throw new Error("Backup contém diretório de anexos não declarado.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  validateSqliteIntegrity(path.join(root, "threadmark.sqlite"));
  if (manifest.components.settings) {
    JSON.parse(await readFile(path.join(root, "settings.json"), "utf8"));
  }
  return manifest;
}

/** Lists recognized backups. Invalid/corrupt entries are returned with their error. */
export async function listLocalBackups(
  options: ListLocalBackupsOptions,
): Promise<ListedLocalBackup[]> {
  let entries;
  try {
    entries = await readdir(options.backupsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry): Promise<ListedLocalBackup | null> => {
        const directory = path.join(options.backupsDirectory, entry.name);
        try {
          const manifest = options.verifyIntegrity === false
            ? parseManifest(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")))
            : await validateLocalBackup({ directory });
          return {
            id: manifest.id,
            directory,
            createdAt: manifest.createdAt,
            mode: manifest.mode,
            kind: manifest.kind,
            valid: true,
            size: manifest.files.reduce((total, file) => total + file.size, 0),
          };
        } catch (error) {
          return {
            id: entry.name,
            directory,
            createdAt: null,
            mode: null,
            kind: null,
            valid: false,
            error: error instanceof Error ? error.message : String(error),
            size: 0,
          };
        }
      }),
  );

  return backups
    .filter((item): item is ListedLocalBackup => item !== null)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

/** Applies per-kind/mode retention without ever deleting unrecognized or corrupt directories. */
export async function pruneLocalBackups(
  options: PruneLocalBackupsOptions,
): Promise<PruneLocalBackupsResult> {
  const backups = (await listLocalBackups({
    backupsDirectory: options.backupsDirectory,
    verifyIntegrity: true,
  })).filter((backup) => backup.valid);
  const groups = new Map<string, ListedLocalBackup[]>();
  for (const backup of backups) {
    const key = retentionKey(backup);
    groups.set(key, [...(groups.get(key) ?? []), backup]);
  }

  const deleted: string[] = [];
  const kept: string[] = [];
  for (const [key, group] of groups) {
    const limit = retentionLimit(options.retention, key);
    for (const [index, backup] of group.entries()) {
      if (limit === undefined || index < limit) {
        kept.push(backup.id);
        continue;
      }
      assertDirectChild(options.backupsDirectory, backup.directory);
      await rm(backup.directory, { recursive: true, force: true });
      deleted.push(backup.id);
    }
  }
  return { deleted, kept };
}

/**
 * Restores only while the daemon is stopped. The source is validated and staged first;
 * current state is preserved as a full safety backup and as an immediate rollback copy.
 */
export async function restoreLocalBackup(
  options: RestoreLocalBackupOptions,
): Promise<RestoreLocalBackupResult> {
  const lockPath = path.join(path.dirname(options.databasePath), ".restore.lock");
  return withRestoreLock(lockPath, () => restoreLocalBackupUnlocked(options));
}

async function restoreLocalBackupUnlocked(
  options: RestoreLocalBackupOptions,
): Promise<RestoreLocalBackupResult> {
  await assertDaemonStopped(options.pidPath);
  await assertDatabaseExclusive(options.databasePath);
  assertLocalRestoreLayout(options);
  const manifest = await validateLocalBackup({ directory: options.backupDirectory });
  const dataDirectory = path.dirname(options.databasePath);
  const operationDirectory = path.join(dataDirectory, `.restore-${randomUUID()}`);
  const stagingDirectory = path.join(operationDirectory, "staging");
  const rollbackDirectory = path.join(operationDirectory, "rollback");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(rollbackDirectory, { recursive: true, mode: 0o700 });

  let safetyBackup: LocalBackupResult | null = null;
  let originalMoved = false;
  let restored: RestoreLocalBackupResult | null = null;
  try {
    await copyRestoreSource(options.backupDirectory, stagingDirectory, manifest);
    await validateLocalBackup({ directory: stagingDirectory });
    await options.onStep?.("staged");

    safetyBackup = await createSafetyBackup(options);
    await options.onStep?.("safety-backup-created");

    originalMoved = true;
    await moveCurrentStateToRollback(options, rollbackDirectory, manifest.mode);
    await applyStagedState(options, stagingDirectory, manifest);
    await hardenRestoredState(options, manifest.mode);
    restored = {
      backupId: manifest.id,
      mode: manifest.mode,
      restoredAt: (options.now ?? new Date()).toISOString(),
      safetyBackup,
    };
  } catch (error) {
    if (originalMoved) {
      try {
        await rollbackRestore(options, rollbackDirectory, manifest.mode);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `A restauração e o rollback falharam. Use o backup de segurança em ${safetyBackup?.directory ?? "local não disponível"}.`,
        );
      }
    }
    await rm(operationDirectory, { recursive: true, force: true });
    throw error;
  }

  // The restored state is committed only after every operation that can require
  // rollback has succeeded. Retention is housekeeping: it must never turn a
  // successful restore into data loss, so it runs after the rollback copy is
  // retired and is deliberately best-effort.
  await rm(operationDirectory, { recursive: true, force: true });
  if (options.retention) {
    try {
      await pruneLocalBackups({
        backupsDirectory: options.backupsDirectory,
        retention: options.retention,
      });
    } catch (error) {
      console.warn(
        `Backup restaurado, mas a retenção automática não pôde ser aplicada: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return restored;
}

async function withRestoreLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Já existe uma restauração em andamento ou um lock abandonado em ${lockPath}.`,
      );
    }
    throw error;
  }
  await handle.close();
  try {
    return await operation();
  } finally {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
      if (current.token === token) await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Synchronous snapshot used by createDatabase before applying pending migrations. */
export function createPreMigrationBackupSync(
  options: PreMigrationBackupOptions,
): LocalBackupResult {
  const createdAt = (options.now ?? new Date()).toISOString();
  const id = backupId(createdAt, `pre-migration-${options.fromVersion}-to-${options.toVersion}`);
  const directory = path.join(options.backupsDirectory, id);
  const stagingDirectory = path.join(options.backupsDirectory, `.staging-${id}`);
  mkdirSync(options.backupsDirectory, { recursive: true, mode: 0o700 });
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });

  try {
    const snapshotPath = path.join(stagingDirectory, "threadmark.sqlite");
    options.database.exec(`VACUUM INTO ${sqliteString(snapshotPath)}`);
    chmodSync(snapshotPath, 0o600);
    const settingsIncluded = options.settingsPath
      ? copyOptionalRegularFileSync(options.settingsPath, path.join(stagingDirectory, "settings.json"))
      : false;
    const manifest = createManifestSync({
      directory: stagingDirectory,
      id,
      createdAt,
      mode: "quick",
      kind: "pre-migration",
      label: "pre-migration",
      sourceSchemaVersion: options.fromVersion,
      settingsIncluded,
      attachmentsIncluded: false,
      migration: { fromVersion: options.fromVersion, toVersion: options.toVersion },
    });
    writeFileSync(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    validateSqliteIntegrity(snapshotPath);
    renameSync(stagingDirectory, directory);
    prunePreMigrationBackupsSync(options.backupsDirectory, options.retention ?? 5);
    return {
      id,
      directory,
      databasePath: path.join(directory, "threadmark.sqlite"),
      mode: "quick",
      kind: "pre-migration",
      settingsIncluded,
      attachmentsIncluded: false,
      createdAt,
      manifest,
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

interface ManifestInput {
  directory: string;
  id: string;
  createdAt: string;
  mode: LocalBackupMode;
  kind: LocalBackupKind;
  label?: string;
  sourceSchemaVersion: number;
  settingsIncluded: boolean;
  attachmentsIncluded: boolean;
  migration?: LocalBackupManifest["migration"];
}

async function createManifest(input: ManifestInput): Promise<LocalBackupManifest> {
  const files = await Promise.all(
    (await listRegularFiles(input.directory)).map(async (relative) => {
      const absolute = resolveInside(input.directory, relative);
      const fileStats = await stat(absolute);
      return { path: relative, size: fileStats.size, sha256: await sha256File(absolute) };
    }),
  );
  return manifestFromInput(input, files);
}

function createManifestSync(input: ManifestInput): LocalBackupManifest {
  const files = listRegularFilesSync(input.directory).map((relative) => {
    const absolute = resolveInside(input.directory, relative);
    return { path: relative, size: statSync(absolute).size, sha256: sha256FileSync(absolute) };
  });
  return manifestFromInput(input, files);
}

function manifestFromInput(
  input: ManifestInput,
  files: BackupFileEntry[],
): LocalBackupManifest {
  return {
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    id: input.id,
    createdAt: input.createdAt,
    mode: input.mode,
    kind: input.kind,
    ...(input.label ? { label: input.label } : {}),
    sourceSchemaVersion: input.sourceSchemaVersion,
    ...(input.migration ? { migration: input.migration } : {}),
    components: {
      database: true,
      settings: input.settingsIncluded,
      attachments: input.attachmentsIncluded,
      secrets: false,
      whatsappAuth: false,
    },
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function parseManifest(value: unknown): LocalBackupManifest {
  if (!value || typeof value !== "object") throw new Error("Manifesto de backup inválido.");
  const item = value as Partial<LocalBackupManifest>;
  if (item.format !== LOCAL_BACKUP_FORMAT || item.version !== LOCAL_BACKUP_VERSION) {
    throw new Error("Formato ou versão de backup incompatível.");
  }
  if (
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.createdAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !isBackupMode(item.mode) ||
    !isBackupKind(item.kind) ||
    !Number.isSafeInteger(item.sourceSchemaVersion) ||
    !item.components ||
    item.components.database !== true ||
    typeof item.components.settings !== "boolean" ||
    typeof item.components.attachments !== "boolean" ||
    item.components.secrets !== false ||
    item.components.whatsappAuth !== false ||
    !Array.isArray(item.files)
  ) {
    throw new Error("Manifesto de backup incompleto ou inválido.");
  }
  for (const file of item.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Entrada de arquivo inválida no manifesto.");
    }
  }
  return item as LocalBackupManifest;
}

async function copyOptionalRegularFile(source: string, destination: string): Promise<boolean> {
  try {
    const sourceStats = await lstat(source);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`Fonte de backup não é um arquivo regular: ${source}`);
    }
    await copyFile(source, destination);
    await chmod(destination, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function copyOptionalRegularFileSync(source: string, destination: string): boolean {
  try {
    const sourceStats = lstatSync(source);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`Fonte de backup não é um arquivo regular: ${source}`);
    }
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyOptionalDirectory(source: string, destination: string): Promise<boolean> {
  try {
    const sourceStats = await lstat(source);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error(`Fonte de backup não é um diretório regular: ${source}`);
    }
    await copyDirectorySafe(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyDirectorySafe(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Links simbólicos não são permitidos no backup: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyDirectorySafe(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
    } else {
      throw new Error(`Tipo de arquivo não suportado no backup: ${sourcePath}`);
    }
  }
}

async function listRegularFiles(root: string, relative = ""): Promise<string[]> {
  const current = relative ? resolveInside(root, relative) : root;
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup contém link simbólico: ${child}`);
    if (entry.isDirectory()) {
      if (child !== "attachments" && !child.startsWith("attachments/")) {
        throw new Error(`Backup contém diretório não permitido: ${child}`);
      }
      files.push(...(await listRegularFiles(root, child)));
    }
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Backup contém tipo de arquivo não suportado: ${child}`);
  }
  return files;
}

function listRegularFilesSync(root: string, relative = ""): string[] {
  const current = relative ? resolveInside(root, relative) : root;
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup contém link simbólico: ${child}`);
    if (entry.isDirectory()) {
      if (child !== "attachments" && !child.startsWith("attachments/")) {
        throw new Error(`Backup contém diretório não permitido: ${child}`);
      }
      files.push(...listRegularFilesSync(root, child));
    }
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Backup contém tipo de arquivo não suportado: ${child}`);
  }
  return files;
}

async function sha256File(filePath: string): Promise<string> {
  const handle = createReadStream(filePath);
  const hash = createHash("sha256");
  for await (const chunk of handle) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256FileSync(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function validateManifestRelativePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`Caminho inseguro no manifesto: ${value}`);
  }
  return value;
}

function validateComponentPath(relative: string, mode: LocalBackupMode): void {
  if (relative === "threadmark.sqlite" || relative === "settings.json") return;
  if (mode === "full" && relative.startsWith("attachments/")) return;
  throw new Error(`Componente não permitido no backup: ${relative}`);
}

function resolveInside(root: string, relative: string): string {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relative);
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Caminho escapa do diretório permitido: ${relative}`);
  }
  return resolved;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function validateSqliteIntegrity(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite inválido: ${result.map((item) => item.integrity_check).join(", ")}`);
    }
  } finally {
    database.close();
    // SQLite may create empty WAL bookkeeping files even for a readonly open.
    // They are runtime artifacts, never part of a portable backup.
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
  }
}

function readSchemaVersion(database: SupportDatabase): number {
  const table = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { found: number } | undefined;
  if (!table) return 0;
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  return row.version;
}

function inferSettingsPath(database: SupportDatabase): string | undefined {
  return database.name && database.name !== ":memory:"
    ? path.join(path.dirname(database.name), "settings.json")
    : undefined;
}

async function assertDaemonStopped(pidPath: string): Promise<void> {
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && processIsRunning(pid)) {
      throw new Error(`O Threadmark ainda está em execução no PID ${pid}. Pare o serviço antes de restaurar.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertDatabaseExclusive(databasePath: string): Promise<void> {
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("busy_timeout = 100");
    database.exec("BEGIN EXCLUSIVE; ROLLBACK;");
  } catch {
    throw new Error("O banco SQLite está em uso. Pare o Threadmark antes de restaurar.");
  } finally {
    database.close();
  }
}

function assertLocalRestoreLayout(options: RestoreLocalBackupOptions): void {
  const root = path.dirname(path.resolve(options.databasePath));
  if (
    path.dirname(path.resolve(options.settingsPath)) !== root ||
    path.dirname(path.resolve(options.attachmentsDirectory)) !== root
  ) {
    throw new Error("Banco, configurações e anexos devem pertencer ao mesmo diretório local.");
  }
}

async function copyRestoreSource(
  backupDirectory: string,
  stagingDirectory: string,
  manifest: LocalBackupManifest,
): Promise<void> {
  await copyFile(
    path.join(backupDirectory, "threadmark.sqlite"),
    path.join(stagingDirectory, "threadmark.sqlite"),
  );
  await copyFile(
    path.join(backupDirectory, "manifest.json"),
    path.join(stagingDirectory, "manifest.json"),
  );
  if (manifest.components.settings) {
    await copyFile(
      path.join(backupDirectory, "settings.json"),
      path.join(stagingDirectory, "settings.json"),
    );
  }
  if (manifest.mode === "full" && manifest.components.attachments) {
    await copyDirectorySafe(
      path.join(backupDirectory, "attachments"),
      path.join(stagingDirectory, "attachments"),
    );
  }
  await hardenTree(stagingDirectory);
}

async function createSafetyBackup(
  options: RestoreLocalBackupOptions,
): Promise<LocalBackupResult | null> {
  try {
    await stat(options.databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const database = new Database(options.databasePath, { fileMustExist: true });
  try {
    return await createLocalBackup({
      database,
      backupsDirectory: options.backupsDirectory,
      settingsPath: options.settingsPath,
      attachmentsDirectory: options.attachmentsDirectory,
      mode: "full",
      kind: "safety",
      label: "before-restore",
      now: options.now,
    });
  } finally {
    database.close();
  }
}

async function moveCurrentStateToRollback(
  options: RestoreLocalBackupOptions,
  rollbackDirectory: string,
  mode: LocalBackupMode,
): Promise<void> {
  await moveIfExists(options.databasePath, path.join(rollbackDirectory, "threadmark.sqlite"));
  await moveIfExists(`${options.databasePath}-wal`, path.join(rollbackDirectory, "threadmark.sqlite-wal"));
  await moveIfExists(`${options.databasePath}-shm`, path.join(rollbackDirectory, "threadmark.sqlite-shm"));
  await moveIfExists(options.settingsPath, path.join(rollbackDirectory, "settings.json"));
  if (mode === "full") {
    await moveIfExists(options.attachmentsDirectory, path.join(rollbackDirectory, "attachments"));
  }
}

async function applyStagedState(
  options: RestoreLocalBackupOptions,
  stagingDirectory: string,
  manifest: LocalBackupManifest,
): Promise<void> {
  await rename(path.join(stagingDirectory, "threadmark.sqlite"), options.databasePath);
  await options.onStep?.("database-applied");
  if (manifest.components.settings) {
    await rename(path.join(stagingDirectory, "settings.json"), options.settingsPath);
  }
  await options.onStep?.("settings-applied");
  if (manifest.mode === "full") {
    if (manifest.components.attachments) {
      await rename(path.join(stagingDirectory, "attachments"), options.attachmentsDirectory);
    }
    await options.onStep?.("attachments-applied");
  }
}

async function rollbackRestore(
  options: RestoreLocalBackupOptions,
  rollbackDirectory: string,
  mode: LocalBackupMode,
): Promise<void> {
  await rm(options.databasePath, { force: true });
  await rm(`${options.databasePath}-wal`, { force: true });
  await rm(`${options.databasePath}-shm`, { force: true });
  await rm(options.settingsPath, { force: true });
  if (mode === "full") await rm(options.attachmentsDirectory, { recursive: true, force: true });
  await moveIfExists(path.join(rollbackDirectory, "threadmark.sqlite"), options.databasePath);
  await moveIfExists(path.join(rollbackDirectory, "threadmark.sqlite-wal"), `${options.databasePath}-wal`);
  await moveIfExists(path.join(rollbackDirectory, "threadmark.sqlite-shm"), `${options.databasePath}-shm`);
  await moveIfExists(path.join(rollbackDirectory, "settings.json"), options.settingsPath);
  if (mode === "full") {
    await moveIfExists(path.join(rollbackDirectory, "attachments"), options.attachmentsDirectory);
  }
}

async function moveIfExists(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hardenRestoredState(
  options: RestoreLocalBackupOptions,
  mode: LocalBackupMode,
): Promise<void> {
  await chmod(options.databasePath, 0o600);
  try {
    await chmod(options.settingsPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (mode === "full") {
    try {
      await hardenTree(options.attachmentsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function hardenTree(root: string): Promise<void> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink()) throw new Error(`Link simbólico não permitido: ${root}`);
  if (rootStats.isFile()) {
    await chmod(root, 0o600);
    return;
  }
  if (!rootStats.isDirectory()) throw new Error(`Tipo de arquivo não suportado: ${root}`);
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await hardenTree(path.join(root, entry.name));
  }
}

function prunePreMigrationBackupsSync(backupsDirectory: string, retention: number): void {
  const limit = Math.max(1, Math.floor(retention));
  const matches = readdirSync(backupsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const directory = path.join(backupsDirectory, entry.name);
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")));
        return manifest.kind === "pre-migration" ? { directory, createdAt: manifest.createdAt } : null;
      } catch {
        return null;
      }
    })
    .filter((item): item is { directory: string; createdAt: string } => item !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const backup of matches.slice(limit)) {
    assertDirectChild(backupsDirectory, backup.directory);
    rmSync(backup.directory, { recursive: true, force: true });
  }
}

function retentionKey(backup: ListedLocalBackup): string {
  if (backup.kind === "safety") return "safety";
  if (backup.kind === "pre-migration") return "preMigration";
  return backup.mode ?? "quick";
}

function retentionLimit(policy: BackupRetentionPolicy, key: string): number | undefined {
  const raw = policy[key as keyof BackupRetentionPolicy];
  return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
}

function assertDirectChild(root: string, child: string): void {
  if (path.dirname(path.resolve(child)) !== path.resolve(root)) {
    throw new Error(`Recusa ao remover caminho fora do diretório de backups: ${child}`);
  }
}

function backupId(createdAt: string, label?: string): string {
  const stamp = createdAt.replaceAll(":", "-").replaceAll(".", "-");
  const suffix = cleanLabel(label);
  return `${stamp}${suffix ? `-${suffix}` : ""}-${randomUUID().slice(0, 8)}`;
}

function cleanLabel(label?: string): string | undefined {
  const safe = label?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || undefined;
}

function isBackupMode(value: unknown): value is LocalBackupMode {
  return value === "quick" || value === "full";
}

function isBackupKind(value: unknown): value is LocalBackupKind {
  return value === "manual" || value === "scheduled" || value === "safety" || value === "pre-migration";
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
