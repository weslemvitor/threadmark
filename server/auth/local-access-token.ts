import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

/** Machine-local bearer credential used by bundled local clients and the CLI. */
export class LocalAccessToken {
  private digest: Buffer | null = null;

  constructor(readonly filePath: string) {}

  async ensure(): Promise<string> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let token: string;
    try {
      token = (await readFile(this.filePath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = randomBytes(32).toString("base64url");
      try {
        const handle = await open(this.filePath, "wx", 0o600);
        await handle.writeFile(`${token}\n`);
        await handle.close();
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        token = (await readFile(this.filePath, "utf8")).trim();
      }
    }
    if (token.length < 32) throw new Error("Token de acesso local inválido.");
    await chmod(this.filePath, 0o600);
    this.digest = digest(token);
    return token;
  }

  async verify(token: string): Promise<boolean> {
    if (!this.digest) await this.ensure();
    const candidate = digest(token);
    return Boolean(this.digest && timingSafeEqual(this.digest, candidate));
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
