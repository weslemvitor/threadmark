import { spawn } from "node:child_process";

export type ConfigurationSection =
  | "general"
  | "ai"
  | "tools"
  | "whatsapp"
  | "staff"
  | "data";

export function configurationUrl(
  webOrigin: string,
  section: ConfigurationSection = "general",
): string {
  const url = new URL(webOrigin);
  url.pathname = `/settings/${section}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function openLocalInterface(url: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("A interface local precisa usar HTTP ou HTTPS.");
  }
  const { command, arguments: argumentsList } = openerForPlatform(
    process.platform,
    target.toString(),
  );
  const child = spawn(command, argumentsList, {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}

export function openerForPlatform(
  platform: NodeJS.Platform,
  url: string,
): { command: string; arguments: string[] } {
  if (platform === "darwin") return { command: "open", arguments: [url] };
  if (platform === "win32") {
    return { command: "cmd", arguments: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", arguments: [url] };
}
