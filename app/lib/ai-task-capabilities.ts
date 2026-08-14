export type AiTaskCapabilityKind = "triage" | "automatic" | "deep";

export interface TaskCapableConnection {
  enabled: boolean;
  capabilities: {
    triage: boolean;
    automaticAnalysis: boolean;
    deepInvestigation: boolean;
  };
}

export function connectionSupportsTask(
  connection: TaskCapableConnection,
  taskKind: AiTaskCapabilityKind,
): boolean {
  if (!connection.enabled) return false;
  if (taskKind === "triage") return connection.capabilities.triage;
  if (taskKind === "automatic") {
    return connection.capabilities.automaticAnalysis;
  }
  return connection.capabilities.deepInvestigation;
}
