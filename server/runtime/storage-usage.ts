import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

export type LocalStorageComponentKey =
  | "sqlite"
  | "attachments"
  | "backups"
  | "logs"
  | "other";

export interface LocalStorageComponentUsage {
  bytes: number;
  files: number;
}

export interface LocalStorageUsageReport {
  measuredAt: string;
  totalBytes: number;
  components: Record<LocalStorageComponentKey, LocalStorageComponentUsage>;
  scan: {
    entriesVisited: number;
    directoriesVisited: number;
    filesCounted: number;
    skippedSymlinks: number;
    skippedSpecialFiles: number;
    unreadableEntries: number;
    truncated: boolean;
  };
}

export interface LocalStorageUsageOptions {
  dataDirectory: string;
  databasePath: string;
  attachmentsDirectory: string;
  backupsDirectory: string;
  logsDirectory: string;
  maxEntries?: number;
  maxDepth?: number;
  maxDurationMs?: number;
  now?: Date;
}

export interface LocalStorageUsageReader {
  read(): Promise<LocalStorageUsageReport>;
}

export class LocalStorageUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalStorageUsageError";
  }
}

const DEFAULT_MAX_ENTRIES = 250_000;
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_DURATION_MS = 10_000;

export class LocalStorageUsageService implements LocalStorageUsageReader {
  private inFlight: Promise<LocalStorageUsageReport> | null = null;

  constructor(private readonly options: LocalStorageUsageOptions) {}

  read(): Promise<LocalStorageUsageReport> {
    if (this.inFlight) return this.inFlight;
    const request = measureLocalStorageUsage(this.options);
    this.inFlight = request.then(
      (result) => {
        this.inFlight = null;
        return result;
      },
      (error: unknown) => {
        this.inFlight = null;
        throw error;
      },
    );
    return this.inFlight;
  }
}

/**
 * Measures regular files below the data root exactly once. Symbolic links and
 * special files are recorded but never followed.
 */
export async function measureLocalStorageUsage(
  options: LocalStorageUsageOptions,
): Promise<LocalStorageUsageReport> {
  const root = path.resolve(options.dataDirectory);
  const classifier = createClassifier(root, options);
  const limits = {
    maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES),
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxDurationMs: positiveInteger(
      options.maxDurationMs,
      DEFAULT_MAX_DURATION_MS,
    ),
  };
  const report = emptyReport(options.now ?? new Date());
  const startedAt = Date.now();

  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw new LocalStorageUsageError(
      "Não foi possível acessar o diretório de dados local.",
      { cause: error },
    );
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new LocalStorageUsageError(
      "O diretório de dados local precisa ser uma pasta real, não um link simbólico.",
    );
  }

  const scanDirectory = async (directory: string, depth: number): Promise<void> => {
    if (shouldStop(report, startedAt, limits)) return;
    if (depth > limits.maxDepth) {
      report.scan.truncated = true;
      return;
    }

    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (depth === 0) {
        throw new LocalStorageUsageError(
          "Não foi possível ler o diretório de dados local.",
          { cause: error },
        );
      }
      report.scan.unreadableEntries += 1;
      return;
    }
    report.scan.directoriesVisited += 1;

    try {
      for await (const entry of handle) {
        if (shouldStop(report, startedAt, limits)) break;
        report.scan.entriesVisited += 1;
        const candidate = path.join(directory, entry.name);
        let stats;
        try {
          stats = await lstat(candidate);
        } catch {
          report.scan.unreadableEntries += 1;
          continue;
        }
        if (stats.isSymbolicLink()) {
          report.scan.skippedSymlinks += 1;
          continue;
        }
        if (stats.isDirectory()) {
          await scanDirectory(candidate, depth + 1);
          continue;
        }
        if (!stats.isFile()) {
          report.scan.skippedSpecialFiles += 1;
          continue;
        }

        const component = classifier(candidate);
        const bytes = allocatedFileBytes(stats);
        report.components[component].bytes = safeByteSum(
          report.components[component].bytes,
          bytes,
          report,
        );
        report.components[component].files += 1;
        report.totalBytes = safeByteSum(report.totalBytes, bytes, report);
        report.scan.filesCounted += 1;
      }
    } catch (error) {
      if (error instanceof LocalStorageUsageError) throw error;
      report.scan.unreadableEntries += 1;
    }
  };

  await scanDirectory(root, 0);
  return report;
}

function allocatedFileBytes(stats: { size: number; blocks?: number }): number {
  const allocated = (stats.blocks ?? Number.NaN) * 512;
  return Number.isFinite(allocated) && (allocated > 0 || stats.size === 0)
    ? allocated
    : Math.max(0, stats.size);
}

function createClassifier(
  root: string,
  options: LocalStorageUsageOptions,
): (candidate: string) => LocalStorageComponentKey {
  const database = validateInsideRoot(root, options.databasePath);
  const sqliteFiles = new Set([
    database,
    `${database}-wal`,
    `${database}-shm`,
  ]);
  const categoryRoots: Array<[LocalStorageComponentKey, string]> = [
    ["attachments", validateInsideRoot(root, options.attachmentsDirectory)],
    ["backups", validateInsideRoot(root, options.backupsDirectory)],
    ["logs", validateInsideRoot(root, options.logsDirectory)],
  ];

  return (candidate) => {
    const absolute = path.resolve(candidate);
    if (sqliteFiles.has(absolute)) return "sqlite";
    for (const [component, categoryRoot] of categoryRoots) {
      if (isAtOrInside(absolute, categoryRoot)) return component;
    }
    return "other";
  };
}

function validateInsideRoot(root: string, candidate: string): string {
  const absolute = path.resolve(candidate);
  if (!isAtOrInside(absolute, root)) {
    throw new LocalStorageUsageError(
      "A configuração de armazenamento local aponta para fora do diretório de dados.",
    );
  }
  return absolute;
}

function isAtOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldStop(
  report: LocalStorageUsageReport,
  startedAt: number,
  limits: { maxEntries: number; maxDurationMs: number },
): boolean {
  const stopped =
    report.scan.entriesVisited >= limits.maxEntries ||
    Date.now() - startedAt >= limits.maxDurationMs;
  if (stopped) report.scan.truncated = true;
  return stopped;
}

function safeByteSum(
  current: number,
  addition: number,
  report: LocalStorageUsageReport,
): number {
  if (addition > Number.MAX_SAFE_INTEGER - current) {
    report.scan.truncated = true;
    return Number.MAX_SAFE_INTEGER;
  }
  return current + addition;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function emptyReport(now: Date): LocalStorageUsageReport {
  const component = (): LocalStorageComponentUsage => ({ bytes: 0, files: 0 });
  return {
    measuredAt: now.toISOString(),
    totalBytes: 0,
    components: {
      sqlite: component(),
      attachments: component(),
      backups: component(),
      logs: component(),
      other: component(),
    },
    scan: {
      entriesVisited: 0,
      directoriesVisited: 0,
      filesCounted: 0,
      skippedSymlinks: 0,
      skippedSpecialFiles: 0,
      unreadableEntries: 0,
      truncated: false,
    },
  };
}
