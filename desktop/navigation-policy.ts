import type { DesktopWorkspaceProfile } from "./workspace-profile.js";
import { workspaceApiUrl, workspaceWebUrl } from "./workspace-profile.js";

export function isAllowedWorkspaceNavigation(
  target: string,
  profile: DesktopWorkspaceProfile,
): boolean {
  const origin = safeOrigin(target);
  if (!origin) return false;
  return new Set([
    new URL(workspaceWebUrl(profile)).origin,
    new URL(workspaceApiUrl(profile)).origin,
  ]).has(origin);
}

export function isSafeExternalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)
    );
  } catch {
    return false;
  }
}

function safeOrigin(target: string): string | null {
  try {
    return new URL(target).origin;
  } catch {
    return null;
  }
}
