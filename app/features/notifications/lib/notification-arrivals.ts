import type { NotificationDto } from "../../../../shared/contracts.js";

const MAX_TRACKED_NOTIFICATION_IDS = 200;

export type NotificationArrivalSnapshot = {
  arrivals: NotificationDto[];
  knownIds: Set<string>;
};

export function collectNotificationArrivals(
  items: NotificationDto[],
  knownIds: ReadonlySet<string>,
  baselineReady: boolean,
): NotificationArrivalSnapshot {
  const arrivals = baselineReady
    ? items
        .filter((item) => !knownIds.has(item.id) && !item.readAt)
        .reverse()
    : [];
  const nextKnownIds = new Set<string>();

  for (const item of items) nextKnownIds.add(item.id);
  for (const id of knownIds) {
    if (nextKnownIds.size >= MAX_TRACKED_NOTIFICATION_IDS) break;
    nextKnownIds.add(id);
  }

  return { arrivals, knownIds: nextKnownIds };
}
