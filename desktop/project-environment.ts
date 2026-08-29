import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECT_ANCESTORS = 8;

/**
 * A desktop build created inside a Threadmark clone should keep using that
 * clone's configured local workspace. Installed releases without a nearby
 * project remain isolated in Electron's userData directory.
 */
export function findThreadmarkProjectEnvironment(
  applicationPath: string,
): string | null {
  let directory = path.resolve(applicationPath);
  for (let depth = 0; depth <= MAX_PROJECT_ANCESTORS; depth += 1) {
    const packagePath = path.join(directory, "package.json");
    const environmentPath = path.join(directory, ".env");
    if (
      existsSync(environmentPath) &&
      existsSync(packagePath) &&
      isThreadmarkPackage(packagePath)
    ) {
      return environmentPath;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function resolveDesktopDataDirectory(input: {
  applicationPath: string;
  userDataDirectory: string;
  configuredDataDirectory?: string | null;
  environmentPath?: string | null;
}): string {
  const configured = input.configuredDataDirectory?.trim();
  if (!configured) return input.userDataDirectory;
  if (path.isAbsolute(configured)) return path.normalize(configured);

  const baseDirectory = input.environmentPath
    ? path.dirname(input.environmentPath)
    : input.applicationPath;
  return path.resolve(baseDirectory, configured);
}

export async function readDesktopDataDirectoryPreference(
  filePath: string,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      dataDirectory?: unknown;
    };
    return typeof parsed.dataDirectory === "string" &&
      path.isAbsolute(parsed.dataDirectory)
      ? path.normalize(parsed.dataDirectory)
      : null;
  } catch {
    return null;
  }
}

export async function writeDesktopDataDirectoryPreference(
  filePath: string,
  dataDirectory: string,
): Promise<void> {
  if (!path.isAbsolute(dataDirectory)) {
    throw new Error("O diretório local do Threadmark deve ser absoluto.");
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ dataDirectory: path.normalize(dataDirectory) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryPath, filePath);
}

function isThreadmarkPackage(packagePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: unknown;
      productName?: unknown;
    };
    return parsed.name === "threadmark" || parsed.productName === "Threadmark";
  } catch {
    return false;
  }
}
