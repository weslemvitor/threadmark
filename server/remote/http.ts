import { RemoteCredentialStore } from "./credential-store.js";
import { HEADLESS_SCHEMA_VERSION } from "../headless/cli.js";
import {
  isSshRemoteTarget,
  RemoteCliError,
  type RemoteTarget,
} from "./registry.js";
import { z } from "zod";

const REMOTE_HTTP_TIMEOUT_MS = 20_000;
// Normaliza respostas de servidores antigos para a identidade única da CLI.
const cliClientSchema = z.string().min(1).transform(() => "threadmark-cli" as const);
const remoteCredentialStatusSchema = z.object({
  credential: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
    name: z.string().min(1),
    scope: z.literal("headless"),
    clientId: cliClientSchema,
    expiresAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  user: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    role: z.enum(["owner", "admin", "operator", "viewer"]),
    active: z.literal(true),
  }).strict(),
  clientId: cliClientSchema,
  headlessSchemaVersion: z.literal(HEADLESS_SCHEMA_VERSION),
}).strict().superRefine((status, context) => {
  if (status.credential.userId !== status.user.id) {
    context.addIssue({
      code: "custom",
      message: "A credencial remota não corresponde ao usuário autenticado.",
      path: ["credential", "userId"],
    });
  }
  if (Date.parse(status.credential.expiresAt) <= Date.now()) {
    context.addIssue({
      code: "custom",
      message: "A credencial remota está expirada.",
      path: ["credential", "expiresAt"],
    });
  }
});

export interface RemoteCredentialStatus {
  credential: {
    id: string;
    userId: string;
    name: string;
    scope: "headless";
    clientId: "threadmark-cli";
    expiresAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  user: {
    id: string;
    displayName: string;
    role: "owner" | "admin" | "operator" | "viewer";
    active: true;
  };
  clientId: "threadmark-cli";
  headlessSchemaVersion: string;
}

export async function remoteCredentialStatus(
  remote: RemoteTarget,
  store = new RemoteCredentialStore(),
): Promise<RemoteCredentialStatus> {
  const httpsRemote = requireHttpsRemote(remote);
  const token = await store.read(httpsRemote);
  return requestCredentialStatus(httpsRemote.url, token, "GET");
}

export async function loginRemote(
  remote: RemoteTarget,
  store = new RemoteCredentialStore(),
): Promise<RemoteCredentialStatus> {
  const httpsRemote = requireHttpsRemote(remote);
  await store.storeInteractively(httpsRemote, true);
  let status: RemoteCredentialStatus;
  let token: string;
  try {
    token = await store.read(httpsRemote, true);
    status = await requestCredentialStatus(httpsRemote.url, token, "GET");
  } catch (error) {
    const candidateRemoved = await store.remove(httpsRemote, true);
    if (!candidateRemoved) {
      throw new RemoteCliError(
        "remote_credential_delete_failed",
        "A nova credencial não foi ativada, mas o item temporário não pôde ser removido do macOS Keychain.",
      );
    }
    throw error;
  }
  const candidateRemoved = await store.remove(httpsRemote, true);
  if (!candidateRemoved) {
    throw new RemoteCliError(
      "remote_credential_delete_failed",
      "A credencial foi validada, mas o item temporário não pôde ser removido do macOS Keychain.",
    );
  }
  await store.write(httpsRemote, token);
  return status;
}

export async function logoutRemote(
  remote: RemoteTarget,
  store = new RemoteCredentialStore(),
): Promise<RemoteCredentialStatus> {
  const httpsRemote = requireHttpsRemote(remote);
  const token = await store.read(httpsRemote);
  let status: RemoteCredentialStatus;
  try {
    status = await requestCredentialStatus(httpsRemote.url, token, "DELETE");
  } catch (error) {
    if (
      error instanceof RemoteCliError
      && ["authentication_required", "invalid_credentials", "http_401"].includes(error.code)
    ) {
      const removed = await store.remove(httpsRemote);
      if (!removed) {
        throw new RemoteCliError(
          "remote_credential_delete_failed",
          "A credencial remota já não é aceita pelo servidor e não pôde ser removida do macOS Keychain.",
        );
      }
    }
    throw error;
  }
  const removed = await store.remove(httpsRemote);
  if (!removed) {
    throw new RemoteCliError(
      "remote_credential_delete_failed",
      "A credencial foi revogada no servidor, mas não pôde ser removida do macOS Keychain.",
    );
  }
  return status;
}

function requireHttpsRemote(remote: RemoteTarget) {
  if (isSshRemoteTarget(remote)) {
    throw new RemoteCliError(
      "remote_transport_mismatch",
      `O remoto “${remote.name}” usa SSH e não possui login HTTPS.`,
    );
  }
  return remote;
}

async function requestCredentialStatus(
  apiUrl: string,
  token: string,
  method: "GET" | "DELETE",
): Promise<RemoteCredentialStatus> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/integration-credentials/current", `${apiUrl}/`), {
      method,
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REMOTE_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new RemoteCliError(
      "remote_transport_unavailable",
      "Não foi possível alcançar a API HTTPS do Threadmark.",
    );
  }
  const payload = (await response.json().catch(() => null)) as
    | RemoteCredentialStatus
    | { error?: { code?: string; message?: string }; message?: string }
    | null;
  if (!response.ok) {
    const objectPayload = payload && typeof payload === "object" ? payload : null;
    const error = objectPayload && "error" in objectPayload ? objectPayload.error : null;
    throw new RemoteCliError(
      error?.code ?? `http_${response.status}`,
      error?.message
        ?? (objectPayload && "message" in objectPayload ? objectPayload.message : undefined)
        ?? `A API respondeu HTTP ${response.status}.`,
    );
  }
  const parsed = remoteCredentialStatusSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RemoteCliError(
      "remote_response_invalid",
      "A API remota retornou uma resposta de autenticação inválida.",
    );
  }
  const revokedAtMatchesMethod = method === "DELETE"
    ? parsed.data.credential.revokedAt !== null
    : parsed.data.credential.revokedAt === null;
  if (!revokedAtMatchesMethod) {
    throw new RemoteCliError(
      "remote_response_invalid",
      "A API remota retornou um estado de revogação incompatível com a operação.",
    );
  }
  return parsed.data;
}
