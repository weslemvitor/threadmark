import { readdir, readFile as readFileRaw } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledEntryFiles = new Set([
  "conversations-view.tsx",
  "dashboard-view.tsx",
  "directory-view.tsx",
  "kanban-view.tsx",
  "settings-view.tsx",
  "ticket-detail.tsx",
  "threadmark-ai.tsx",
]);

function belongsToEntry(entryFile: string, relatedFile: string): boolean {
  const name = path.basename(relatedFile);
  if (entryFile === "directory-view.tsx") {
    return name.startsWith("directory-");
  }
  if (entryFile === "conversations-view.tsx") {
    return (
      name.startsWith("conversation-") &&
      name !== "conversation-action-dialog.tsx"
    );
  }
  if (entryFile === "ticket-detail.tsx") {
    return (
      name.startsWith("ticket-") &&
      !name.startsWith("ticket-list")
    );
  }
  return true;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      if (
        entry.isFile() &&
        /\.(?:ts|tsx)$/.test(entry.name) &&
        entry.name !== "index.ts"
      ) {
        return [target];
      }
      return [];
    }),
  );
  return nested.flat().toSorted();
}

/**
 * Source-contract tests validate a feature, not the historical monolithic file.
 * When a public view is requested, return that controller first followed by the
 * feature components/domain modules it composes.
 */
export async function readFrontendFile(
  target: URL,
  encoding: BufferEncoding,
): Promise<string> {
  const primary = await readFileRaw(target, encoding);
  const pathname = fileURLToPath(target);
  if (!bundledEntryFiles.has(path.basename(pathname))) return primary;

  const featureMarker = `${path.sep}app${path.sep}features${path.sep}`;
  const markerIndex = pathname.indexOf(featureMarker);
  if (markerIndex < 0) return primary;
  const featureSegments = pathname
    .slice(markerIndex + featureMarker.length)
    .split(path.sep);
  const featureRoot = path.join(
    pathname.slice(0, markerIndex + featureMarker.length),
    featureSegments[0],
  );
  const entryFile = path.basename(pathname);
  const files = (await sourceFiles(featureRoot)).filter(
    (file) => file !== pathname && belongsToEntry(entryFile, file),
  );
  const related = await Promise.all(
    files.map((file) => readFileRaw(file, encoding)),
  );
  return [primary, ...related].join("\n\n");
}
