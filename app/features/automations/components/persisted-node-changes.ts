import type { Node, NodeChange } from "@xyflow/react";

export function persistedNodeChanges<NodeType extends Node>(
  changes: NodeChange<NodeType>[],
): NodeChange<NodeType>[] {
  return changes.filter(
    (change) =>
      change.type === "remove" ||
      (change.type === "position" && change.dragging !== true),
  );
}
