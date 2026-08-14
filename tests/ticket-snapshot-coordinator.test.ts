import assert from "node:assert/strict";
import test from "node:test";

import { TicketSnapshotCoordinator } from "../app/lib/ticket-snapshot-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("coordenador deduplica leituras simultâneas do mesmo ticket", async () => {
  const coordinator = new TicketSnapshotCoordinator<{ revision: number }>();
  const pending = deferred<{ revision: number }>();
  let calls = 0;
  const load = () => {
    calls += 1;
    return pending.promise;
  };

  const first = coordinator.request("ticket-1", load);
  const duplicate = coordinator.request("ticket-1", load);

  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  pending.resolve({ revision: 1 });
  assert.deepEqual((await first).detail, { revision: 1 });
});

test("coordenador rejeita snapshot anterior a uma mutação", async () => {
  const coordinator = new TicketSnapshotCoordinator<{ revision: number }>();
  const staleRequest = deferred<{ revision: number }>();
  const freshRequest = deferred<{ revision: number }>();

  const stalePromise = coordinator.request("ticket-1", () => staleRequest.promise);
  coordinator.invalidate("ticket-1");
  const freshPromise = coordinator.request("ticket-1", () => freshRequest.promise);

  staleRequest.resolve({ revision: 1 });
  const staleSnapshot = await stalePromise;
  assert.equal(coordinator.isCurrent("ticket-1", staleSnapshot), false);

  freshRequest.resolve({ revision: 2 });
  const freshSnapshot = await freshPromise;
  assert.equal(coordinator.isCurrent("ticket-1", freshSnapshot), true);
  assert.deepEqual(freshSnapshot.detail, { revision: 2 });
});

test("segunda invalidação fecha a janela de leitura durante a mutação", async () => {
  const coordinator = new TicketSnapshotCoordinator<{ revision: number }>();
  const duringMutation = deferred<{ revision: number }>();

  coordinator.invalidate("ticket-1");
  const duringMutationPromise = coordinator.request(
    "ticket-1",
    () => duringMutation.promise,
  );

  coordinator.invalidate("ticket-1");
  duringMutation.resolve({ revision: 1 });
  const staleSnapshot = await duringMutationPromise;
  assert.equal(coordinator.isCurrent("ticket-1", staleSnapshot), false);

  const committedSnapshot = await coordinator.request("ticket-1", async () => ({
    revision: 2,
  }));
  assert.equal(coordinator.isCurrent("ticket-1", committedSnapshot), true);
});

test("coordenador limpa falhas e invalida respostas após remoção", async () => {
  const coordinator = new TicketSnapshotCoordinator<{ revision: number }>();
  const failed = coordinator.request("ticket-1", async () => {
    throw new Error("indisponível");
  });
  await assert.rejects(failed, /indisponível/);

  const recovered = await coordinator.request("ticket-1", async () => ({ revision: 2 }));
  assert.equal(coordinator.isCurrent("ticket-1", recovered), true);

  coordinator.forget("ticket-1");
  assert.equal(coordinator.isCurrent("ticket-1", recovered), false);
});
