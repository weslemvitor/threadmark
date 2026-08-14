export type ComparableAiTaskKind = "triage" | "automatic" | "deep";

export interface ComparableAiTaskProfile {
  taskKind: ComparableAiTaskKind;
  connectionId: string | null;
  model: string;
  enabled: boolean;
}

function comparableProfile(
  profiles: readonly ComparableAiTaskProfile[],
  taskKind: ComparableAiTaskKind,
) {
  const profile = profiles.find((item) => item.taskKind === taskKind);
  return {
    connectionId: profile?.connectionId ?? null,
    model: profile?.model.trim() ?? "",
    enabled: profile?.enabled ?? false,
  };
}

/** Ignores persistence metadata and compares only operator-controlled fields. */
export function aiTaskProfilesMatch(
  drafts: readonly ComparableAiTaskProfile[],
  persisted: readonly ComparableAiTaskProfile[],
): boolean {
  const managedTaskKinds = new Set(drafts.map((profile) => profile.taskKind));
  return Array.from(managedTaskKinds).every((taskKind) => {
    const draft = comparableProfile(drafts, taskKind);
    const saved = comparableProfile(persisted, taskKind);
    return (
      draft.connectionId === saved.connectionId &&
      draft.model === saved.model &&
      draft.enabled === saved.enabled
    );
  });
}
