import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
} from "electron";

import {
  isAllowedWorkspaceNavigation,
  isSafeExternalUrl,
} from "./navigation-policy.js";
import { hasUsableLocalWorkspace } from "./local-workspace.js";
import {
  LOCAL_WORKSPACE_PROFILE,
  readDesktopWorkspaceProfile,
  workspaceApiUrl,
  workspaceWebUrl,
  writeDesktopWorkspaceProfile,
  type DesktopWorkspaceProfile,
} from "./workspace-profile.js";

const APPLICATION_NAME = "Threadmark";
const WORKSPACE_PROFILE_FILE = "desktop-workspace.json";
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;

let mainWindow: BrowserWindow | null = null;
let activeProfile: DesktopWorkspaceProfile = LOCAL_WORKSPACE_PROFILE;
let localStart: Promise<void> | null = null;

app.setName(APPLICATION_NAME);
app.setAppUserModelId("com.threadmark.desktop");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktopApplication).catch(showFatalError);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  void createMainWindow();
});

async function startDesktopApplication(): Promise<void> {
  loadProjectEnvironment();
  activeProfile = await readDesktopWorkspaceProfile(workspaceProfilePath());
  configurePermissions();
  registerIpcHandlers();
  installApplicationMenu();
  await createMainWindow();
}

async function createMainWindow(): Promise<void> {
  const profile = activeProfile;
  const window = new BrowserWindow({
    title: APPLICATION_NAME,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-desktop", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      additionalArguments: desktopArguments(profile),
    },
  });
  mainWindow = window;
  secureWindowNavigation(window, profile);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  await loadStartupPage(window);
  await loadActiveWorkspace(window);
}

async function loadActiveWorkspace(window = mainWindow): Promise<void> {
  if (!window || window.isDestroyed()) return;
  const profile = activeProfile;
  try {
    if (profile.mode === "local") {
      await loadStartupPage(window);
      await ensureLocalWorkspaceRunning();
    } else {
      await loadStartupPage(window);
    }
    if (window.isDestroyed()) return;
    await window.loadURL(workspaceWebUrl(profile));
  } catch (error) {
    if (window.isDestroyed()) return;
    await loadFailurePage(
      window,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function ensureLocalWorkspaceRunning(): Promise<void> {
  if (
    await hasUsableLocalWorkspace(
      workspaceApiUrl(LOCAL_WORKSPACE_PROFILE),
      workspaceWebUrl(LOCAL_WORKSPACE_PROFILE),
    )
  ) {
    return;
  }
  if (localStart) return localStart;
  localStart = runThreadmarkCli(["on"]).catch((error) => {
    localStart = null;
    throw error;
  });
  return localStart;
}

function runThreadmarkCli(argumentsList: string[]): Promise<void> {
  const projectRoot = app.getAppPath();
  const executable = path.join(projectRoot, "bin", "threadmark.mjs");
  if (!existsSync(executable)) {
    throw new Error("O executável local do Threadmark não foi incluído no aplicativo.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...argumentsList], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          detail ||
            `O serviço local encerrou ${signal ? `com o sinal ${signal}` : `com o código ${code ?? "desconhecido"}`}.`,
        ),
      );
    });
  });
}

function secureWindowNavigation(
  window: BrowserWindow,
  profile: DesktopWorkspaceProfile,
): void {
  window.webContents.on("will-navigate", (event, target) => {
    if (isAllowedWorkspaceNavigation(target, profile)) return;
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function configurePermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function registerIpcHandlers(): void {
  ipcMain.removeHandler("desktop:set-workspace-profile");
  ipcMain.handle(
    "desktop:set-workspace-profile",
    async (event: IpcMainInvokeEvent, input: unknown) => {
      assertTrustedSender(event);
      const saved = await writeDesktopWorkspaceProfile(workspaceProfilePath(), input);
      activeProfile = saved;
      installApplicationMenu();
      setTimeout(() => void recreateMainWindow(), 100);
      return saved;
    },
  );
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Origem da configuração do workspace não autorizada.");
  }
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl) {
    throw new Error("A página atual não informou uma origem válida.");
  }
  if (!isAllowedWorkspaceNavigation(senderUrl, activeProfile)) {
    throw new Error("A página atual não pode alterar a conexão do workspace.");
  }
}

async function recreateMainWindow(): Promise<void> {
  const previous = mainWindow;
  mainWindow = null;
  if (previous && !previous.isDestroyed()) previous.destroy();
  await createMainWindow();
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: APPLICATION_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        {
          label: "Encerrar aplicativo e serviço local…",
          enabled: activeProfile.mode === "local",
          click: () => void stopLocalWorkspaceAndQuit(),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Workspace",
      submenu: [
        {
          label: "Nesta máquina",
          type: "radio",
          checked: activeProfile.mode === "local",
          click: () => void switchToLocalWorkspace(),
        },
        { type: "separator" },
        {
          label: "Configurar conexão…",
          click: () => void openDesktopSettings(),
        },
        {
          label: "Recarregar workspace",
          accelerator: "CmdOrCtrl+R",
          click: () => void loadActiveWorkspace(),
        },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function stopLocalWorkspaceAndQuit(): Promise<void> {
  const window = mainWindow;
  const confirmationOptions: MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancelar", "Encerrar tudo"],
    defaultId: 0,
    cancelId: 0,
    title: "Encerrar Threadmark",
    message: "Encerrar o aplicativo e o serviço local?",
    detail:
      "A captura do WhatsApp, as automações e os jobs locais ficarão parados até o Threadmark ser aberto novamente.",
    noLink: true,
  };
  const confirmation = window
    ? await dialog.showMessageBox(window, confirmationOptions)
    : await dialog.showMessageBox(confirmationOptions);
  if (confirmation.response !== 1) return;

  try {
    await runThreadmarkCli(["off"]);
    app.quit();
  } catch (error) {
    const errorOptions: MessageBoxOptions = {
      type: "error",
      buttons: ["OK"],
      title: "Não foi possível encerrar o serviço",
      message: "O aplicativo continua aberto para proteger os dados locais.",
      detail: error instanceof Error ? error.message : String(error),
    };
    if (window) await dialog.showMessageBox(window, errorOptions);
    else await dialog.showMessageBox(errorOptions);
  }
}

async function switchToLocalWorkspace(): Promise<void> {
  if (activeProfile.mode === "local") {
    await loadActiveWorkspace();
    return;
  }
  activeProfile = await writeDesktopWorkspaceProfile(
    workspaceProfilePath(),
    LOCAL_WORKSPACE_PROFILE,
  );
  installApplicationMenu();
  await recreateMainWindow();
}

async function openDesktopSettings(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const settingsUrl = new URL("/settings/desktop", workspaceWebUrl(activeProfile));
  await window.loadURL(settingsUrl.toString());
}

async function loadStartupPage(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(app.getAppPath(), "desktop", "static", "startup.html"));
}

async function loadFailurePage(window: BrowserWindow, message: string): Promise<void> {
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threadmark</title><style>${failureStyles()}</style></head>
<body><main><div class="brand">Threadmark</div><section><div class="icon">!</div><h1>Não foi possível abrir o workspace</h1><p>${safeMessage}</p><small>Use Workspace → Recarregar workspace. Se estiver em um servidor remoto, você também pode voltar para “Nesta máquina”.</small></section></main></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function desktopArguments(profile: DesktopWorkspaceProfile): string[] {
  return [
    `--threadmark-workspace-mode=${profile.mode}`,
    `--threadmark-server-url=${encodeURIComponent(profile.mode === "remote" ? profile.serverUrl : "")}`,
    `--threadmark-api-url=${encodeURIComponent(workspaceApiUrl(profile))}`,
    `--threadmark-data-dir=${encodeURIComponent(resolveDesktopDataDirectory())}`,
  ];
}

function resolveDesktopDataDirectory(): string {
  const configured = process.env.SUPPORT_DATA_DIR?.trim();
  return configured ? path.resolve(app.getAppPath(), configured) : app.getPath("userData");
}

function loadProjectEnvironment(): void {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(path.join(app.getAppPath(), ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function workspaceProfilePath(): string {
  return path.join(app.getPath("userData"), WORKSPACE_PROFILE_FILE);
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_COMMAND_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_COMMAND_OUTPUT_BYTES);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });
}

function failureStyles(): string {
  return `*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#182033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:32px}.brand{position:fixed;left:28px;top:24px;font-weight:700}section{width:min(520px,100%);padding:38px;border:1px solid #e2e8f0;border-radius:24px;background:white;text-align:center;box-shadow:0 18px 50px rgba(15,23,42,.08)}.icon{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 20px;border-radius:16px;background:#fff1f2;color:#e11d48;font-weight:800}h1{margin:0;font-size:24px}p{margin:14px 0;color:#64748b;line-height:1.6;overflow-wrap:anywhere}small{display:block;margin-top:22px;color:#94a3b8;line-height:1.5}`;
}

function showFatalError(error: unknown): void {
  console.error(error);
  app.quit();
}
