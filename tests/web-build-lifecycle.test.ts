import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import packageJson from "../package.json" with { type: "json" };
import viteConfig from "../vite.config.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import {
  WebBuildReloadMonitor,
  requestWebBuildReload,
} from "../server/runtime/web-build-reload.js";
import {
  webBuildLockPath,
  withWebBuildLock,
} from "../server/runtime/web-build-lock.js";
import {
  WebProcessController,
  type ManagedWebProcess,
} from "../server/runtime/web-process.js";
import {
  verifyWebBuild,
  waitForWebBuildReady,
} from "../server/runtime/web-readiness.js";

class FakeWebProcess extends EventEmitter implements ManagedWebProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(readonly pid: number) {
    super();
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const normalizedSignal = typeof signal === "number" ? "SIGTERM" : signal;
    this.signals.push(normalizedSignal);
    queueMicrotask(() => {
      this.signalCode = normalizedSignal;
      this.emit("exit", null, normalizedSignal);
    });
    return true;
  }
}

test("novo build reinicia somente o processo web e aguarda o anterior encerrar", async () => {
  const processes: FakeWebProcess[] = [];
  const controller = new WebProcessController(() => {
    const child = new FakeWebProcess(10_000 + processes.length);
    processes.push(child);
    return child;
  });

  controller.start();
  await Promise.all([controller.restart(), controller.restart()]);

  assert.equal(processes.length, 2);
  assert.deepEqual(processes[0]?.signals, ["SIGTERM"]);
  assert.equal(controller.pid, processes[1]?.pid);

  await controller.stop();
  assert.deepEqual(processes[1]?.signals, ["SIGTERM"]);
});

test("watchdog reinicia a interface com backoff após encerramento inesperado", async () => {
  const processes: FakeWebProcess[] = [];
  const scheduled: Array<{ delay: number; attempt: number }> = [];
  const errors: Error[] = [];
  const controller = new WebProcessController(
    () => {
      const child = new FakeWebProcess(20_000 + processes.length);
      processes.push(child);
      return child;
    },
    {
      restartBackoffMs: [1],
      restartResetAfterMs: 50,
      onError: (error) => errors.push(error),
      onRestartScheduled: (delay, attempt) => scheduled.push({ delay, attempt }),
    },
  );

  const first = controller.start() as FakeWebProcess;
  first.exitCode = 1;
  first.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(processes.length, 2);
  assert.deepEqual(scheduled, [{ delay: 1, attempt: 1 }]);
  assert.match(errors[0]?.message ?? "", /encerrou inesperadamente/);
  assert.equal(controller.pid, processes[1]?.pid);

  await controller.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(processes.length, 2, "parada explícita não pode acionar o watchdog");
});

test("monitor ignora o build atual e processa uma nova solicitação uma única vez", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-web-build-"));
  const requestPath = path.join(root, "web-build.reload");
  try {
    await requestWebBuildReload(requestPath, "build-inicial");
    let reloads = 0;
    const monitor = new WebBuildReloadMonitor(requestPath, async () => {
      reloads += 1;
    });
    await monitor.start();

    await monitor.pollNow();
    assert.equal(reloads, 0);

    await requestWebBuildReload(requestPath, "build-novo");
    await monitor.pollNow();
    await monitor.pollNow();
    assert.equal(reloads, 1);
    assert.equal((await readFile(requestPath, "utf8")).trim(), "build-novo");

    monitor.stop();
    await requestWebBuildReload(requestPath, "build-apos-stop");
    await monitor.pollNow();
    assert.equal(reloads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API expõe a revisão atual sem permitir cache", async () => {
  const database = createDatabase(":memory:");
  try {
    const app = createTestApiApp(new SupportStore(database));
    const response = await app.request("/api/runtime/web-build");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    const payload = (await response.json()) as { revision: string | null };
    assert.ok(payload.revision === null || typeof payload.revision === "string");
  } finally {
    database.close();
  }
});

test("monitor repete a solicitação quando o novo processo web ainda não ficou pronto", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-web-retry-"));
  const requestPath = path.join(root, "web-build.reload");
  try {
    let attempts = 0;
    const monitor = new WebBuildReloadMonitor(requestPath, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("web ainda indisponível");
    });
    await monitor.start();
    await requestWebBuildReload(requestPath, "build-com-retry");

    await assert.rejects(monitor.pollNow(), /web ainda indisponível/);
    await monitor.pollNow();
    assert.equal(attempts, 2);
    monitor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness exige HTML, CSS e JavaScript do mesmo build", async () => {
  const responses = new Map<string, { status: number; body?: string }>([
    [
      "http://127.0.0.1:3999/",
      {
        status: 200,
        body: '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>',
      },
    ],
    ["http://127.0.0.1:3999/assets/app.css", { status: 200 }],
    ["http://127.0.0.1:3999/assets/app.js", { status: 200 }],
  ]);
  const fetcher = (async (input: string | URL | Request) => {
    const key = input instanceof Request ? input.url : String(input);
    const fixture = responses.get(key) ?? { status: 404 };
    return new Response(fixture.body ?? "", { status: fixture.status });
  }) as typeof fetch;

  await verifyWebBuild("http://127.0.0.1:3999", fetcher);

  responses.set("http://127.0.0.1:3999/assets/app.css", { status: 404 });
  await assert.rejects(
    waitForWebBuildReady("http://127.0.0.1:3999", {
      fetcher,
      timeoutMs: 5,
      retryIntervalMs: 0,
    }),
    /app\.css respondeu 404/,
  );
});

test("readiness aceita os assets de produção emitidos pelo Vinext", async () => {
  const responses = new Map<string, { status: number; body?: string }>([
    [
      "http://127.0.0.1:3999/",
      {
        status: 200,
        body: '<link rel="stylesheet" href="/_next/static/css/layout.css"><script src="/_next/static/chunks/index.js"></script>',
      },
    ],
    ["http://127.0.0.1:3999/_next/static/css/layout.css", { status: 200 }],
    ["http://127.0.0.1:3999/_next/static/chunks/index.js", { status: 200 }],
  ]);
  const fetcher = (async (input: string | URL | Request) => {
    const key = input instanceof Request ? input.url : String(input);
    const fixture = responses.get(key) ?? { status: 404 };
    return new Response(fixture.body ?? "", { status: fixture.status });
  }) as typeof fetch;

  await verifyWebBuild("http://127.0.0.1:3999", fetcher);
});

test("lock impede dois builds de escrever no dist ao mesmo tempo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-web-lock-"));
  const lockPath = webBuildLockPath(root);
  try {
    let active = 0;
    let maximumActive = 0;
    let successfulBuilds = 0;
    const attempts = Array.from({ length: 20 }, () =>
      withWebBuildLock(lockPath, async () => {
        successfulBuilds += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
      }).catch((error: unknown) => error),
    );

    await Promise.all(attempts);
    assert.equal(successfulBuilds, 1);
    assert.equal(maximumActive, 1);
    await withWebBuildLock(lockPath, async () => undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock abandonado bloqueia o build sem apagar o arquivo automaticamente", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-stale-lock-"));
  const lockPath = webBuildLockPath(root);
  try {
    await writeFile(lockPath, "", { mode: 0o600 });
    await assert.rejects(
      withWebBuildLock(lockPath, async () => undefined),
      /lock abandonado/,
    );
    assert.equal(await readFile(lockPath, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build preserva assets ativos e só solicita reload depois do Vinext concluir", () => {
  assert.equal(viteConfig.build?.emptyOutDir, false);
  assert.equal(
    packageJson.scripts["build:web"],
    "tsx server/runtime/build-web.ts",
  );
});
