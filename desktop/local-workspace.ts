const THREADMARK_API_SERVICE = "threadmark-api";

export async function hasUsableLocalWorkspace(
  apiUrl: string,
  webUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const [health, web] = await Promise.all([
      fetcher(new URL("/health", apiUrl), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      fetcher(new URL("/", webUrl), {
        headers: { accept: "text/html" },
        signal: controller.signal,
      }),
    ]);
    if (!health.ok || !web.ok) return false;

    const payload = (await health.json()) as Record<string, unknown>;
    if (
      payload.ok !== true ||
      payload.service !== THREADMARK_API_SERVICE ||
      !Number.isInteger(payload.pid) ||
      Number(payload.pid) <= 0
    ) {
      return false;
    }

    const html = await web.text();
    const assetPaths = [
      ...new Set(
        [...html.matchAll(
          /(?:href|src)="((?:\/assets\/|\/_next\/static\/)[^"?#]+\.(?:css|js))[^\"]*"/g,
        )].map((match) => match[1]),
      ),
    ];
    if (!assetPaths.some((asset) => asset.endsWith(".css"))) return false;
    if (!assetPaths.some((asset) => asset.endsWith(".js"))) return false;

    const assets = await Promise.all(
      assetPaths.map((assetPath) =>
        fetcher(new URL(assetPath, webUrl), { signal: controller.signal }),
      ),
    );
    return assets.every((asset) => asset.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
