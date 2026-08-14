import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const localSettingsSchema = z.object({
  monitoredGroupJids: z.array(z.string().trim().min(1)).default([]),
  staffIdentities: z.array(z.string().trim().min(1)).default([]),
  staffIdentitiesConfigured: z.boolean().default(false),
  staffRestartRequired: z.boolean().default(false),
});

export type LocalSettings = z.infer<typeof localSettingsSchema>;

export class LocalSettingsFile {
  constructor(private readonly filePath: string) {}

  async read(): Promise<LocalSettings> {
    try {
      return localSettingsSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return localSettingsSchema.parse({});
      }
      throw error;
    }
  }

  async write(settings: LocalSettings): Promise<void> {
    const normalized = localSettingsSchema.parse({
      monitoredGroupJids: unique(settings.monitoredGroupJids),
      staffIdentities: unique(settings.staffIdentities),
      staffIdentitiesConfigured: settings.staffIdentitiesConfigured,
      staffRestartRequired: settings.staffRestartRequired,
    });
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export function mergeConfiguredIdentities(
  environmentValues: string[],
  localValues: string[],
): string[] {
  return unique([...environmentValues, ...localValues]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
