import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release desktop publica somente o DMG arm64 validado e seu checksum", async () => {
  const [packageSource, workflow, desktopBuilder] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile(".github/workflows/release-desktop.yml", "utf8"),
    readFile("bin/build-desktop.mjs", "utf8"),
  ]);
  const metadata = JSON.parse(packageSource) as {
    version: string;
    scripts: Record<string, string>;
    build: {
      appId: string;
      productName: string;
      mac: { icon: string; target: string[] };
      dmg: { artifactName: string };
    };
  };

  assert.equal(metadata.build.appId, "com.threadmark.desktop");
  assert.equal(metadata.build.productName, "Threadmark");
  assert.equal(metadata.build.mac.icon, "desktop/assets/threadmark-icon.icns");
  assert.deepEqual(metadata.build.mac.target, ["dmg"]);
  assert.equal(
    metadata.build.dmg.artifactName,
    "Threadmark-${version}-${arch}.${ext}",
  );
  assert.match(metadata.scripts["release:desktop"], /release:check/);
  assert.match(metadata.scripts["release:desktop"], /desktop:artifact:check/);
  assert.match(desktopBuilder, /"--publish",\s*"never"/);

  const webProcess = await readFile("server/runtime/web-process.ts", "utf8");
  assert.match(webProcess, /bin["'], ["']start-web\.mjs/);
  assert.doesNotMatch(webProcess, /vinextCli/);

  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /npm run release:desktop/);
  assert.match(workflow, /\.dmg\.sha256/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /--clobber/);
  assert.match(workflow, /--prerelease/);
});

test("instalação unsigned exige origem oficial e checksum antes do xattr", async () => {
  const [readme, upgrade, desktopMain, cli] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("UPGRADE.md", "utf8"),
    readFile("desktop/main.ts", "utf8"),
    readFile("server/cli.ts", "utf8"),
  ]);

  for (const documentation of [readme, upgrade]) {
    assert.match(documentation, /shasum -a 256 -c/);
    assert.match(
      documentation,
      /xattr -dr com\.apple\.quarantine "\/Applications\/Threadmark\.app"/,
    );
    assert.match(documentation, /release oficial/i);
  }

  assert.match(desktopMain, /Encerrar aplicativo e serviço local/);
  assert.match(desktopMain, /runThreadmarkCli\(\["off"\]\)/);
  assert.match(desktopMain, /THREADMARK_DESKTOP_START: "1"/);
  assert.match(desktopMain, /const resolved = resolveDesktopDataDirectoryPath/);
  assert.match(desktopMain, /process\.env\.SUPPORT_DATA_DIR = resolved/);
  assert.match(desktopMain, /writeDesktopDataDirectoryPreference/);
  assert.match(desktopMain, /readDesktopDataDirectoryPreference/);
  assert.match(desktopMain, /backgroundThrottling: false/);
  assert.match(cli, /process\.env\.THREADMARK_DESKTOP_START === "1"/);
  assert.match(cli, /Workspace local pronto/);
});
