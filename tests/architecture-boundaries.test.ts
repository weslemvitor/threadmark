import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path: string) => new URL(`../${path}`, import.meta.url);

test("frontend organiza superfícies por features com API pública", async () => {
  const featureNames = [
    "access",
    "categories",
    "conversations",
    "dashboard",
    "directory",
    "kanban",
    "settings",
    "tickets",
  ];
  const [supportApp, page, threadmarkPage, componentEntries] = await Promise.all([
    readFile(projectFile("app/support-app.tsx"), "utf8"),
    readFile(projectFile("app/page.tsx"), "utf8"),
    readFile(projectFile("app/threadmark-page.tsx"), "utf8"),
    import("node:fs/promises").then(({ readdir }) =>
      readdir(projectFile("app/components/"), { withFileTypes: true }),
    ),
  ]);

  for (const featureName of featureNames) {
    const publicApi = await readFile(
      projectFile(`app/features/${featureName}/index.ts`),
      "utf8",
    );
    assert.match(
      publicApi,
      /from "\.\/(?:components|domain|services)\//,
      `${featureName} precisa expor uma API pública curta`,
    );
  }

  assert.match(page, /from "\.\/threadmark-page"/);
  assert.match(threadmarkPage, /from "\.\/features\/access"/);
  assert.doesNotMatch(threadmarkPage, /components\/app-access-gate/);
  for (const featureName of featureNames.filter((name) => name !== "access")) {
    assert.match(
      supportApp,
      new RegExp(`from "\\./features/${featureName}"|import\\("\\./features/${featureName}"\\)`),
      `support-app deve consumir o barrel de ${featureName}`,
    );
  }
  assert.doesNotMatch(supportApp, /\.\/components\/(?:ticket|conversation|directory|settings|kanban|dashboard|categories)/);
  assert.deepEqual(
    componentEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".tsx")),
    [],
    "app/components deve conter somente as pastas ui, layout e shared",
  );
});
