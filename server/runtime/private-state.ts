import { chmod, lstat, opendir } from "node:fs/promises";

export interface HardenPrivateStateResult {
  directories: number;
  files: number;
  skippedSymlinks: number;
}

/** Restricts an existing local data tree without following symbolic links. */
export async function hardenPrivateState(
  root: string,
): Promise<HardenPrivateStateResult> {
  const result: HardenPrivateStateResult = {
    directories: 0,
    files: 0,
    skippedSymlinks: 0,
  };
  await hardenEntry(root, result);
  return result;
}

async function hardenEntry(
  entryPath: string,
  result: HardenPrivateStateResult,
): Promise<void> {
  let entry;
  try {
    entry = await lstat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    result.skippedSymlinks += 1;
    return;
  }
  if (!entry.isDirectory()) {
    await chmod(entryPath, 0o600);
    result.files += 1;
    return;
  }

  await chmod(entryPath, 0o700);
  result.directories += 1;
  const directory = await opendir(entryPath);
  for await (const child of directory) {
    await hardenEntry(`${entryPath}/${child.name}`, result);
  }
}
