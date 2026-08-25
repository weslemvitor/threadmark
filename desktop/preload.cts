import { contextBridge, ipcRenderer } from "electron";

type DesktopWorkspaceProfile =
  | { mode: "local" }
  | { mode: "remote"; serverUrl: string };

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : "";
}

const mode = argument("threadmark-workspace-mode") === "remote" ? "remote" : "local";
const serverUrl = argument("threadmark-server-url");
const profile: DesktopWorkspaceProfile =
  mode === "remote" && serverUrl
    ? { mode: "remote", serverUrl }
    : { mode: "local" };

contextBridge.exposeInMainWorld("threadmarkDesktop", {
  apiUrl: argument("threadmark-api-url") || "http://127.0.0.1:4317",
  dataDirectory: argument("threadmark-data-dir"),
  isDesktop: true,
  profile,
  setWorkspaceProfile: (nextProfile: DesktopWorkspaceProfile) =>
    ipcRenderer.invoke("desktop:set-workspace-profile", nextProfile),
});
