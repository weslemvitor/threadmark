import type { AutomationDetail } from "./automation-types.js";

export function editableAutomationSignature(
  automation: AutomationDetail | null,
): string {
  if (!automation) return "";
  return JSON.stringify({
    definition: {
      ...automation.definition,
      nodes: automation.definition.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        ...(node.name ? { name: node.name } : {}),
        config: node.config,
      })),
    },
  });
}

export function automationMetadataSignature(
  automation: AutomationDetail | null,
): string {
  if (!automation) return "";
  return JSON.stringify({
    name: automation.name.trim(),
    description: automation.description?.trim() || null,
  });
}
