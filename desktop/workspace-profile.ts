import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopWorkspaceProfile =
  | { mode: "local" }
  | { mode: "remote"; serverUrl: string };

export const LOCAL_WORKSPACE_PROFILE: DesktopWorkspaceProfile = { mode: "local" };

export async function readDesktopWorkspaceProfile(
  filePath: string,
): Promise<DesktopWorkspaceProfile> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseDesktopWorkspaceProfile(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return LOCAL_WORKSPACE_PROFILE;
    }
    return LOCAL_WORKSPACE_PROFILE;
  }
}

export async function writeDesktopWorkspaceProfile(
  filePath: string,
  input: unknown,
): Promise<DesktopWorkspaceProfile> {
  const profile = parseDesktopWorkspaceProfile(input);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
  return profile;
}

export function parseDesktopWorkspaceProfile(
  input: unknown,
): DesktopWorkspaceProfile {
  if (!input || typeof input !== "object") {
    throw new Error("Perfil de workspace inválido.");
  }

  const candidate = input as Record<string, unknown>;
  if (candidate.mode === "local") return LOCAL_WORKSPACE_PROFILE;
  if (candidate.mode !== "remote") {
    throw new Error("Selecione o modo local ou remoto.");
  }
  if (typeof candidate.serverUrl !== "string") {
    throw new Error("Informe a URL HTTPS do servidor Threadmark.");
  }

  return {
    mode: "remote",
    serverUrl: normalizeRemoteServerUrl(candidate.serverUrl),
  };
}

export function normalizeRemoteServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Informe uma URL válida para o servidor Threadmark.");
  }

  const isLocalDevelopment =
    url.protocol === "http:" &&
    new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("Workspaces remotos exigem HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("A URL do workspace não pode conter usuário ou senha.");
  }
  if (url.search || url.hash) {
    throw new Error("A URL do workspace não pode conter parâmetros ou fragmentos.");
  }
  if (url.pathname !== "/") {
    throw new Error("Use somente a origem do servidor, sem caminhos adicionais.");
  }

  return url.origin;
}

export function workspaceWebUrl(profile: DesktopWorkspaceProfile): string {
  return profile.mode === "local"
    ? "http://127.0.0.1:3000"
    : profile.serverUrl;
}

export function workspaceApiUrl(profile: DesktopWorkspaceProfile): string {
  return profile.mode === "local"
    ? "http://127.0.0.1:4317"
    : profile.serverUrl;
}
