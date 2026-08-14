import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Web UI faz bind explícito somente no loopback em dev e produção", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  assert.match(packageJson.scripts["dev:web"], /vinext dev --hostname 127\.0\.0\.1$/);
  assert.match(packageJson.scripts["start:web"], /vinext start --hostname 127\.0\.0\.1$/);
  assert.doesNotMatch(packageJson.scripts["dev:web"], /0\.0\.0\.0/);
  assert.doesNotMatch(packageJson.scripts["start:web"], /0\.0\.0\.0/);
});
