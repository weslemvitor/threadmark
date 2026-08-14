import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type EncryptedSecret = {
  iv: string;
  tag: string;
  ciphertext: string;
};

type SecretDocument = {
  version: 1;
  secrets: Record<string, EncryptedSecret>;
};

const EMPTY_DOCUMENT: SecretDocument = { version: 1, secrets: {} };

/**
 * Small local encrypted vault for provider credentials.
 *
 * The encryption key and ciphertext are separate 0600 files. This prevents a
 * copied SQLite database or support export from carrying API keys with it. The
 * local OS account remains the security boundary, as expected for a local-only
 * installation.
 */
export class LocalSecretVault {
  private readonly keyPath: string;
  private readonly documentPath: string;

  constructor(directory: string) {
    this.keyPath = path.join(directory, "secrets.key");
    this.documentPath = path.join(directory, "secrets.enc.json");
  }

  async set(reference: string, value: string): Promise<void> {
    assertReference(reference);
    if (!value) throw new Error("O segredo não pode ser vazio.");
    const key = await this.readOrCreateKey();
    const document = await this.readDocument();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(reference, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    document.secrets[reference] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await this.writeDocument(document);
  }

  async get(reference: string): Promise<string | null> {
    assertReference(reference);
    const encrypted = (await this.readDocument()).secrets[reference];
    if (!encrypted) return null;
    const key = await this.readOrCreateKey();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(reference, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async delete(reference: string): Promise<boolean> {
    assertReference(reference);
    const document = await this.readDocument();
    if (!document.secrets[reference]) return false;
    delete document.secrets[reference];
    await this.writeDocument(document);
    return true;
  }

  private async readOrCreateKey(): Promise<Buffer> {
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(this.keyPath);
      if (existing.length !== 32) throw new Error("Chave local de segredos inválida.");
      await chmod(this.keyPath, 0o600);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const created = randomBytes(32);
    try {
      const handle = await open(this.keyPath, "wx", 0o600);
      await handle.writeFile(created);
      await handle.close();
      return created;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(this.keyPath);
      if (existing.length !== 32) throw new Error("Chave local de segredos inválida.");
      return existing;
    }
  }

  private async readDocument(): Promise<SecretDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, "utf8")) as SecretDocument;
      if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object") {
        throw new Error("Cofre local de segredos inválido.");
      }
      await chmod(this.documentPath, 0o600);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY_DOCUMENT, secrets: {} };
      }
      throw error;
    }
  }

  private async writeDocument(document: SecretDocument): Promise<void> {
    await mkdir(path.dirname(this.documentPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.documentPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await rename(temporary, this.documentPath);
    await chmod(this.documentPath, 0o600);
  }
}

function assertReference(reference: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(reference)) {
    throw new Error("Referência de segredo inválida.");
  }
}
