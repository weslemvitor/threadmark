import assert from "node:assert/strict";
import test from "node:test";

import { collectNotificationArrivals } from "../app/features/notifications/lib/notification-arrivals.js";
import type { NotificationDto } from "../shared/contracts.js";

test("primeira consulta estabelece a linha de base sem repetir notificações antigas", () => {
  const oldNotification = notification("old", null, "2026-08-24T12:00:00.000Z");
  const snapshot = collectNotificationArrivals([oldNotification], new Set(), false);

  assert.deepEqual(snapshot.arrivals, []);
  assert.equal(snapshot.knownIds.has("old"), true);
});

test("consultas seguintes exibem somente notificações novas e não lidas", () => {
  const latest = notification("latest", null, "2026-08-24T12:02:00.000Z");
  const first = notification("first", null, "2026-08-24T12:01:00.000Z");
  const old = notification("old", null, "2026-08-24T12:00:00.000Z");
  const alreadyRead = notification(
    "read",
    "2026-08-24T12:02:30.000Z",
    "2026-08-24T12:02:30.000Z",
  );

  const snapshot = collectNotificationArrivals(
    [alreadyRead, latest, first, old],
    new Set(["old"]),
    true,
  );

  assert.deepEqual(snapshot.arrivals.map((item) => item.id), ["first", "latest"]);
  assert.equal(snapshot.knownIds.has("read"), true);
});

test("notificação já conhecida não reaparece em uma consulta posterior", () => {
  const item = notification("new", null, "2026-08-24T12:03:00.000Z");
  const firstSnapshot = collectNotificationArrivals([item], new Set(), true);
  const secondSnapshot = collectNotificationArrivals(
    [item],
    firstSnapshot.knownIds,
    true,
  );

  assert.deepEqual(firstSnapshot.arrivals.map((entry) => entry.id), ["new"]);
  assert.deepEqual(secondSnapshot.arrivals, []);
});

function notification(
  id: string,
  readAt: string | null,
  createdAt: string,
): NotificationDto {
  return {
    id,
    title: `Notificação ${id}`,
    body: "Uma atualização do Threadmark.",
    targetUrl: "/kanban",
    sourceType: "automation",
    sourceId: "automation-1",
    tone: "info",
    readAt,
    createdAt,
  };
}
