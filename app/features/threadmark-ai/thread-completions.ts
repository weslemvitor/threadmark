import type { ThreadmarkAiThreadListResponse } from "../../../shared/contracts.js";

type ThreadListItem = ThreadmarkAiThreadListResponse["items"][number];

export type ThreadmarkAiCompletionSnapshot = {
  completions: ThreadListItem[];
  fingerprints: Map<string, string | null>;
};

export function collectThreadmarkAiCompletions(
  items: ThreadListItem[],
  knownFingerprints: ReadonlyMap<string, string | null>,
  baselineReady: boolean,
): ThreadmarkAiCompletionSnapshot {
  const completions = baselineReady
    ? items.filter((item) => {
        if (!item.unread || !item.lastAssistantMessageAt) return false;
        return knownFingerprints.get(item.id) !== item.lastAssistantMessageAt;
      })
    : [];

  return {
    completions,
    fingerprints: new Map(
      items.map((item) => [item.id, item.lastAssistantMessageAt]),
    ),
  };
}

export function unreadThreadmarkAiCount(items: ThreadListItem[]): number {
  return items.filter((item) => item.unread).length;
}
