import assert from "node:assert/strict";
import test from "node:test";

import {
  getInvestigationNotificationTitle,
  resolveBrowserNotificationState,
  shouldNotifyInvestigationTransition,
} from "../app/lib/investigation-notifications.js";

test("notifica somente quando uma investigação observada termina", () => {
  assert.equal(shouldNotifyInvestigationTransition("running", "completed"), true);
  assert.equal(shouldNotifyInvestigationTransition("queued", "failed"), true);
  assert.equal(shouldNotifyInvestigationTransition("completed", "completed"), false);
  assert.equal(shouldNotifyInvestigationTransition(null, "failed"), false);
});

test("não notifica estado antigo no primeiro carregamento e detecta job novo muito rápido", () => {
  const monitoringStartedAt = Date.parse("2026-07-17T03:00:00.000Z");

  assert.equal(
    shouldNotifyInvestigationTransition(undefined, "completed", {
      finishedAt: "2026-07-17T02:59:59.000Z",
      monitoringStartedAt,
    }),
    false,
  );
  assert.equal(
    shouldNotifyInvestigationTransition(undefined, "completed", {
      finishedAt: "2026-07-17T03:00:01.000Z",
      monitoringStartedAt,
    }),
    true,
  );
});

test("copy distingue investigação automática e aprofundada", () => {
  assert.equal(
    getInvestigationNotificationTitle("automatic", "completed"),
    "Investigação automática concluída",
  );
  assert.equal(
    getInvestigationNotificationTitle("deep", "failed"),
    "Investigação aprofundada falhou",
  );
});

test("consentimento diferencia navegador sem suporte, permissão negada e opt-in", () => {
  assert.equal(
    resolveBrowserNotificationState({
      supported: false,
      permission: "default",
      optedIn: false,
    }),
    "unsupported",
  );
  assert.equal(
    resolveBrowserNotificationState({
      supported: true,
      permission: "denied",
      optedIn: true,
    }),
    "blocked",
  );
  assert.equal(
    resolveBrowserNotificationState({
      supported: true,
      permission: "granted",
      optedIn: false,
    }),
    "disabled",
  );
  assert.equal(
    resolveBrowserNotificationState({
      supported: true,
      permission: "granted",
      optedIn: true,
    }),
    "enabled",
  );
});
