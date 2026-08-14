import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

interface WebBuildLockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export function webBuildLockPath(dataDir: string): string {
  return path.join(dataDir, ".web-build.lock");
}

export async function withWebBuildLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = await acquireWebBuildLock(lockPath);
  try {
    return await operation();
  } finally {
    await releaseWebBuildLock(lockPath, owner.token);
  }
}

async function acquireWebBuildLock(lockPath: string): Promise<WebBuildLockOwner> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner: WebBuildLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  let claimed = false;
  try {
    const handle = await open(lockPath, "wx", 0o600);
    claimed = true;
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
    } finally {
      await handle.close();
    }
    return owner;
  } catch (error) {
    if (claimed) await rm(lockPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const current = await readLock(lockPath);
  if (current && isProcessRunning(current.owner.pid)) {
    throw new Error(
      `Ja existe um build web em andamento no PID ${current.owner.pid}. Aguarde a conclusao.`,
    );
  }
  throw new Error(
    `Existe um lock abandonado em ${lockPath}. Confirme que nao ha build web ativo e remova esse arquivo antes de tentar novamente.`,
  );
}

async function releaseWebBuildLock(lockPath: string, token: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current?.owner.token === token) await rm(lockPath, { force: true });
}

async function readLock(
  lockPath: string,
): Promise<{ raw: string; owner: WebBuildLockOwner } | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WebBuildLockOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return { raw, owner: parsed as WebBuildLockOwner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
