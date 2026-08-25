export type DesktopWorkspaceProfile =
  | { mode: "local" }
  | { mode: "remote"; serverUrl: string };

export interface ThreadmarkDesktopBridge {
  apiUrl: string;
  dataDirectory: string;
  isDesktop: true;
  profile: DesktopWorkspaceProfile;
  setWorkspaceProfile(
    profile: DesktopWorkspaceProfile,
  ): Promise<DesktopWorkspaceProfile>;
}

declare global {
  interface Window {
    threadmarkDesktop?: ThreadmarkDesktopBridge;
  }
}

export function getThreadmarkDesktopBridge(): ThreadmarkDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.threadmarkDesktop ?? null;
}

export function configuredApiUrl(): string | null {
  return getThreadmarkDesktopBridge()?.apiUrl ?? null;
}
