import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import type { DirectorySnapshotDto } from "../shared/contracts.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

test("API do Diretório expõe somente grupos e pessoas", async () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({ phoneNumber: "+5547000000000", displayName: "Conta" });
  const client = store.upsertClient({ name: "Operação", slug: "operacao", kind: "ecommerce" });
  store.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000000@g.us",
    subject: "Grupo de suporte",
  });

  const app = createTestApiApp(store);
  const response = await app.request("/api/directory");
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as DirectorySnapshotDto;
  assert.deepEqual(snapshot.totals, { groups: 1, people: 0 });
  assert.deepEqual(Object.keys(snapshot).toSorted(), ["groups", "people", "totals"]);
});

test("rotas removidas de registros e segmentos não são mais expostas", async () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const app = createTestApiApp(new SupportStore(database));
  const removedRoutes = [
    "/api/directory/types",
    "/api/directory/fields",
    "/api/directory/records",
    "/api/directory/segments",
    "/api/settings/record-connectors",
  ];

  for (const route of removedRoutes) {
    const response = await app.request(route);
    assert.equal(response.status, 404, `${route} deve permanecer removida`);
  }
});
