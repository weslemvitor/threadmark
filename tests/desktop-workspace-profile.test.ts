import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_WORKSPACE_PROFILE,
  normalizeRemoteServerUrl,
  parseDesktopWorkspaceProfile,
  readDesktopWorkspaceProfile,
  writeDesktopWorkspaceProfile,
} from "../desktop/workspace-profile.js";
import {
  isAllowedWorkspaceNavigation,
  isSafeExternalUrl,
} from "../desktop/navigation-policy.js";
import { hasUsableLocalWorkspace } from "../desktop/local-workspace.js";

test("desktop inicia em modo local sem exigir configuração ou servidor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-desktop-"));
  const profile = await readDesktopWorkspaceProfile(path.join(root, "missing.json"));
  assert.deepEqual(profile, LOCAL_WORKSPACE_PROFILE);
});

test("perfil remoto aceita somente uma origem HTTPS sem credenciais", () => {
  assert.deepEqual(
    parseDesktopWorkspaceProfile({
      mode: "remote",
      serverUrl: "https://support.example.com/",
    }),
    { mode: "remote", serverUrl: "https://support.example.com" },
  );
  assert.throws(
    () => normalizeRemoteServerUrl("http://support.example.com"),
    /HTTPS/,
  );
  const urlWithCredentials = new URL("https://support.example.com");
  urlWithCredentials.username = "operator";
  urlWithCredentials.password = "fixture-password";
  assert.throws(
    () => normalizeRemoteServerUrl(urlWithCredentials.toString()),
    /usuário ou senha/,
  );
  assert.throws(
    () => normalizeRemoteServerUrl("https://support.example.com/threadmark"),
    /sem caminhos adicionais/,
  );
});

test("perfil desktop é persistido fora do SQLite com permissão privada", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-desktop-"));
  const filePath = path.join(root, "private", "desktop-workspace.json");
  const expected = {
    mode: "remote" as const,
    serverUrl: "https://support.example.com",
  };

  await writeDesktopWorkspaceProfile(filePath, expected);

  assert.deepEqual(await readDesktopWorkspaceProfile(filePath), expected);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), expected);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("navegação do aplicativo fica restrita ao workspace ativo", () => {
  const local = { mode: "local" as const };
  assert.equal(
    isAllowedWorkspaceNavigation("http://127.0.0.1:3000/kanban", local),
    true,
  );
  assert.equal(
    isAllowedWorkspaceNavigation("http://127.0.0.1:4317/api/runtime", local),
    true,
  );
  assert.equal(
    isAllowedWorkspaceNavigation("https://example.com/phishing", local),
    false,
  );

  const remote = {
    mode: "remote" as const,
    serverUrl: "https://support.example.com",
  };
  assert.equal(
    isAllowedWorkspaceNavigation("https://support.example.com/dashboard", remote),
    true,
  );
  assert.equal(
    isAllowedWorkspaceNavigation("https://other.example.com", remote),
    false,
  );
});

test("links externos aceitam HTTPS e recursos locais, mas nunca protocolos executáveis", () => {
  assert.equal(isSafeExternalUrl("https://developers.openai.com"), true);
  assert.equal(isSafeExternalUrl("http://127.0.0.1:4317/api/attachments/a"), true);
  assert.equal(isSafeExternalUrl("file:///tmp/secret"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
});

test("empacotamento desktop preserva os runtimes nativos local e Electron", async () => {
  const metadata = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  ) as {
    main?: string;
    scripts?: Record<string, string>;
    build?: { asar?: boolean; npmRebuild?: boolean };
  };

  assert.equal(metadata.main, "dist-desktop/main.js");
  assert.match(metadata.scripts?.["desktop:pack"] ?? "", /build-desktop\.mjs dir/);
  assert.match(metadata.scripts?.["desktop:dist"] ?? "", /build-desktop\.mjs dmg/);
  assert.equal(metadata.build?.asar, false);
  assert.equal(metadata.build?.npmRebuild, false);
});

test("desktop reutiliza uma instalação Threadmark local já ativa", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "threadmark-api",
        pid: 1234,
      });
    }
    if (url.pathname.startsWith("/_next/static/")) {
      return new Response("asset", { status: 200 });
    }
    return new Response(
      '<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script>',
      { headers: { "content-type": "text/html" } },
    );
  };

  assert.equal(
    await hasUsableLocalWorkspace(
      "http://127.0.0.1:4317",
      "http://127.0.0.1:3000",
      fetcher,
    ),
    true,
  );
});

test("desktop rejeita uma Web UI cujo HTML aponta para assets ausentes", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "threadmark-api",
        pid: 1234,
      });
    }
    if (url.pathname === "/_next/static/app.css") {
      return new Response("css", { status: 200 });
    }
    if (url.pathname === "/_next/static/app.js") {
      return new Response("ausente", { status: 404 });
    }
    return new Response(
      '<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script>',
      { headers: { "content-type": "text/html" } },
    );
  };

  assert.equal(
    await hasUsableLocalWorkspace(
      "http://127.0.0.1:4317",
      "http://127.0.0.1:3000",
      fetcher,
    ),
    false,
  );
});

test("desktop nunca reutiliza um processo local que não confirma ser Threadmark", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    return url.pathname === "/health"
      ? Response.json({ ok: true, service: "outro-servico", pid: 1234 })
      : new Response(
          '<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script>',
        );
  };

  assert.equal(
    await hasUsableLocalWorkspace(
      "http://127.0.0.1:4317",
      "http://127.0.0.1:3000",
      fetcher,
    ),
    false,
  );
});
