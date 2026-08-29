import assert from "node:assert/strict";
import test from "node:test";

import {
  collectThreadmarkAiCompletions,
  unreadThreadmarkAiCount,
} from "../app/features/threadmark-ai/thread-completions.js";
import type { ThreadmarkAiThreadListResponse } from "../shared/contracts.js";

type ThreadListItem = ThreadmarkAiThreadListResponse["items"][number];

function item(
  id: string,
  options: Partial<ThreadListItem> = {},
): ThreadListItem {
  return {
    id,
    title: `Conversa ${id}`,
    status: "active",
    updatedAt: "2026-08-28T18:00:00.000Z",
    lastAssistantMessageAt: null,
    unread: false,
    activeTurnState: null,
    ...options,
  };
}

test("conclusão nova toca uma vez e o indicador permanece enquanto não for lida", () => {
  const running = item("mine", { activeTurnState: "running" });
  const baseline = collectThreadmarkAiCompletions([running], new Map(), false);
  assert.deepEqual(baseline.completions, []);

  const completed = item("mine", {
    lastAssistantMessageAt: "2026-08-28T18:02:00.000Z",
    unread: true,
  });
  const arrival = collectThreadmarkAiCompletions(
    [completed],
    baseline.fingerprints,
    true,
  );
  assert.deepEqual(arrival.completions.map((thread) => thread.id), ["mine"]);
  assert.equal(unreadThreadmarkAiCount([completed]), 1);

  const nextPoll = collectThreadmarkAiCompletions(
    [completed],
    arrival.fingerprints,
    true,
  );
  assert.deepEqual(nextPoll.completions, []);
  assert.equal(unreadThreadmarkAiCount([completed]), 1);
});

test("baseline não toca respostas antigas e só considera conversas retornadas para o usuário", () => {
  const ownUnread = item("own", {
    lastAssistantMessageAt: "2026-08-28T17:00:00.000Z",
    unread: true,
  });
  const snapshot = collectThreadmarkAiCompletions(
    [ownUnread],
    new Map([["other-user", "2026-08-28T18:00:00.000Z"]]),
    false,
  );

  assert.deepEqual(snapshot.completions, []);
  assert.deepEqual([...snapshot.fingerprints.keys()], ["own"]);
});
