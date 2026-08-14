export type KanbanTab = "active" | "archived";

const KANBAN_TABS: KanbanTab[] = ["active", "archived"];

export function getNextKanbanTab(
  current: KanbanTab,
  key: string,
): KanbanTab | null {
  if (key === "Home") return KANBAN_TABS[0];
  if (key === "End") return KANBAN_TABS[KANBAN_TABS.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const direction = key === "ArrowRight" ? 1 : -1;
  const currentIndex = KANBAN_TABS.indexOf(current);
  const nextIndex =
    (currentIndex + direction + KANBAN_TABS.length) % KANBAN_TABS.length;
  return KANBAN_TABS[nextIndex];
}
