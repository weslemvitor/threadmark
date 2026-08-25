import { API_URL, ApiError } from "./api";
import { notifySessionExpired } from "./session-events";

export type AppRole = "owner" | "admin" | "operator" | "viewer";

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: AppRole;
  active: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceIdentity {
  name: string;
  timezone: string;
}

export interface SetupStatus {
  completed: boolean;
  legacyInstallation: boolean;
  bootstrapTokenRequired: boolean;
  workspace: WorkspaceIdentity;
}

export interface SessionState {
  user: AuthenticatedUser;
  workspace: WorkspaceIdentity;
  expiresAt: string;
}

export interface CompleteSetupInput {
  bootstrapToken?: string;
  workspaceName: string;
  timezone: string;
  displayName: string;
  login: string;
  password: string;
}

async function accessRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(10_000);
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Não foi possível alcançar o serviço local do Threadmark.",
    );
  }
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired();
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } | string; message?: string }
      | null;
    throw new ApiError(
      payload?.message ??
        (typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message) ??
        `A API respondeu com ${response.status}.`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export function getSetupStatus(): Promise<SetupStatus> {
  return accessRequest<SetupStatus>("/api/setup/status");
}

export function getCurrentSession(): Promise<SessionState> {
  return accessRequest<SessionState>("/api/auth/me");
}

export function completeLocalSetup(
  input: CompleteSetupInput,
): Promise<SessionState> {
  return accessRequest<SessionState>("/api/setup/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function loginLocal(input: {
  login: string;
  password: string;
}): Promise<SessionState> {
  return accessRequest<SessionState>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function logoutLocal(): Promise<void> {
  await accessRequest<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export function changeLocalPassword(input: {
  currentPassword: string;
  password: string;
}): Promise<SessionState> {
  return accessRequest<SessionState>("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
