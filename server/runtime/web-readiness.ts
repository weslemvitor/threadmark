export interface WebReadinessOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  fetcher?: typeof fetch;
}

export async function waitForWebBuildReady(
  origin: string,
  options: WebReadinessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = options.retryIntervalMs ?? 150;
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  do {
    const controller = new AbortController();
    const attemptTimeout = Math.max(1, Math.min(2_000, deadline - Date.now()));
    const attemptTimer = setTimeout(() => controller.abort(), attemptTimeout);
    try {
      await verifyWebBuild(origin, fetcher, controller.signal);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(attemptTimer);
    }
    if (Date.now() < deadline) await wait(retryIntervalMs);
  } while (Date.now() < deadline);

  throw new Error(
    `A interface web nao ficou pronta em ${timeoutMs}ms: ${lastError?.message ?? "erro desconhecido"}`,
  );
}

export async function verifyWebBuild(
  origin: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = new URL(origin);
  const root = await fetcher(baseUrl, {
    headers: { accept: "text/html" },
    signal,
  });
  if (!root.ok) throw new Error(`HTML respondeu ${root.status}`);
  const html = await root.text();
  const assetPaths = [
    ...new Set(
      [...html.matchAll(
        /(?:href|src)="((?:\/assets\/|\/_next\/static\/)[^"?#]+\.(?:css|js))[^\"]*"/g,
      )].map((match) => match[1]),
    ),
  ];
  if (!assetPaths.some((asset) => asset.endsWith(".css"))) {
    throw new Error("HTML nao referencia CSS do build");
  }
  if (!assetPaths.some((asset) => asset.endsWith(".js"))) {
    throw new Error("HTML nao referencia JavaScript do build");
  }

  const results = await Promise.all(
    assetPaths.map(async (assetPath) => {
      const response = await fetcher(new URL(assetPath, baseUrl), { signal });
      return { assetPath, status: response.status, ok: response.ok };
    }),
  );
  const failed = results.find((result) => !result.ok);
  if (failed) throw new Error(`${failed.assetPath} respondeu ${failed.status}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
