"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/app/components/shared/ui-states";
import { cn } from "@/app/lib/utils";
import {
  automationNodeCatalogId,
  automationNodeDefinition,
  automationNodeConfigurationSummary,
  getAutomationConfigValue,
  type AutomationDefinition,
  type AutomationEdgeDto,
  type AutomationNodeDefinition,
  type AutomationValidationIssue,
  type AutomationExecution,
} from "../domain";
import {
  AutomationEdge,
  type AutomationFlowEdge,
  type AutomationFlowEdgeData,
} from "./automation-edge";
import {
  AutomationNode,
  type AutomationFlowNode,
  type AutomationFlowNodeData,
} from "./automation-node";
import { DryRunPanel } from "./dry-run-panel";
import { persistedNodeChanges } from "./persisted-node-changes";

const nodeTypes = { automation: AutomationNode };
const edgeTypes = { automation: AutomationEdge };

type AutomationCanvasProps = {
  catalog: AutomationNodeDefinition[];
  definition: AutomationDefinition;
  issues: AutomationValidationIssue[];
  selectedNodeId: string | null;
  onAddNode: (catalogId: string, position?: { x: number; y: number }) => void;
  onChange: (definition: AutomationDefinition) => void;
  onLayoutChange: (
    nodes: Array<{ id: string; position: { x: number; y: number } }>,
  ) => void;
  onConfigureNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  dryRun: AutomationExecution | null;
  dryRunError: string | null;
  dryRunOpen: boolean;
  dryRunRunning: boolean;
  onCloseDryRun: () => void;
  onRunDryRun: () => void;
};

function configured(
  data: AutomationDefinition["nodes"][number]["config"],
  definition: AutomationNodeDefinition,
): boolean {
  return definition.fields
    .filter((field) => field.required)
    .every((field) => {
      const value = getAutomationConfigValue(data, field.key);
      return value !== null && value !== undefined && String(value).trim().length > 0;
    });
}

export function AutomationCanvas({
  catalog,
  definition,
  issues,
  selectedNodeId,
  onAddNode,
  onChange,
  onLayoutChange,
  onConfigureNode,
  onRemoveNode,
  onSelectNode,
  dryRun,
  dryRunError,
  dryRunOpen,
  dryRunRunning,
  onCloseDryRun,
  onRunDryRun,
}: AutomationCanvasProps) {
  const instanceRef = useRef<ReactFlowInstance<AutomationFlowNode, AutomationFlowEdge> | null>(null);
  const draggingRef = useRef(false);
  const issueNodeIds = useMemo(
    () => new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.nodeId)),
    [issues],
  );
  const warningNodeIds = useMemo(
    () => new Set(issues.filter((issue) => issue.severity === "warning").map((issue) => issue.nodeId)),
    [issues],
  );

  const flowNodes = useMemo<AutomationFlowNode[]>(
    () =>
      definition.nodes.map((node) => {
        const catalogId = automationNodeCatalogId(node);
        const nodeDefinition = automationNodeDefinition(catalogId, catalog);
        const data: AutomationFlowNodeData = {
          catalogId,
          title: node.name || nodeDefinition?.label || "Etapa indisponível",
          description: nodeDefinition?.description || "Este tipo de nó não está mais disponível.",
          icon: nodeDefinition?.icon || "ticket",
          category: nodeDefinition?.category || "flow_control",
          accent: nodeDefinition?.accent || "violet",
          invalid: issueNodeIds.has(node.id),
          warning: warningNodeIds.has(node.id),
          configured: nodeDefinition ? configured(node.config, nodeDefinition) : false,
          configurationSummary: nodeDefinition
            ? automationNodeConfigurationSummary(node, nodeDefinition)
            : null,
          testStatus: dryRun?.steps.find((step) => step.nodeId === node.id)?.status,
          onEdit: () => onConfigureNode(node.id),
          onRemove: () => onRemoveNode(node.id),
        };
        return {
          id: node.id,
          type: "automation",
          position: node.position,
          selected: selectedNodeId === node.id,
          data,
        };
      }),
    [catalog, definition.nodes, dryRun?.steps, issueNodeIds, onConfigureNode, onRemoveNode, selectedNodeId, warningNodeIds],
  );
  const [renderedNodes, setRenderedNodes] = useState(flowNodes);

  useEffect(() => {
    if (!draggingRef.current) setRenderedNodes(flowNodes);
  }, [flowNodes]);

  const removeEdge = useCallback((edgeId: string) => {
    onChange({
      ...definition,
      edges: definition.edges.filter((edge) => edge.id !== edgeId),
    });
  }, [definition, onChange]);

  const flowEdges = useMemo<AutomationFlowEdge[]>(
    () =>
      definition.edges.map((edge) => ({
        ...edge,
        type: "automation",
        animated: false,
        data: {
          branchLabel:
            edge.sourceHandle === "true" || edge.sourceHandle === "approved"
              ? "Sim"
              : edge.sourceHandle === "false" || edge.sourceHandle === "rejected"
                ? "Não"
                : undefined,
          onRemove: () => removeEdge(edge.id),
        } satisfies AutomationFlowEdgeData,
        style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
      })),
    [definition.edges, removeEdge],
  );

  const nodeLabels = useMemo(
    () => new Map(flowNodes.map((node) => [node.id, node.data.title])),
    [flowNodes],
  );

  function changeNodes(changes: NodeChange<AutomationFlowNode>[]) {
    const dragging = changes.some(
      (change) => change.type === "position" && change.dragging === true,
    );
    const dragFinished = changes.some(
      (change) => change.type === "position" && change.dragging === false,
    );
    if (dragging) draggingRef.current = true;
    setRenderedNodes((current) => applyNodeChanges(changes, current));

    const persistedChanges = persistedNodeChanges(changes);
    if (!persistedChanges.length) return;

    const nextFlowNodes = applyNodeChanges(persistedChanges, flowNodes);
    const nextIds = new Set(nextFlowNodes.map((node) => node.id));
    const hasStructuralChange = persistedChanges.some(
      (change) => change.type !== "position",
    );
    if (hasStructuralChange) {
      onChange({
        ...definition,
        nodes: definition.nodes.filter((node) => nextIds.has(node.id)),
        edges: definition.edges.filter(
          (edge) => nextIds.has(edge.source) && nextIds.has(edge.target),
        ),
      });
    } else {
      onLayoutChange(
        nextFlowNodes.map((node) => ({ id: node.id, position: node.position })),
      );
    }
    if (dragFinished) draggingRef.current = false;
  }

  function changeEdges(changes: EdgeChange<AutomationFlowEdge>[]) {
    const nextEdges = applyEdgeChanges(changes, flowEdges);
    onChange({
      ...definition,
      edges: nextEdges.map<AutomationEdgeDto>((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        label: typeof edge.label === "string" ? edge.label : null,
      })),
    });
  }

  function connect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const duplicate = definition.edges.some(
      (edge) =>
        edge.source === connection.source &&
        edge.target === connection.target &&
        edge.sourceHandle === connection.sourceHandle,
    );
    if (duplicate) return;
    onChange({
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: `edge-${crypto.randomUUID()}`,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
        },
      ],
    });
  }

  function dropNode(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const catalogId = event.dataTransfer.getData("application/threadmark-automation-node");
    if (!catalogId || !instanceRef.current) return;
    onAddNode(
      catalogId,
      instanceRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
  }

  return (
    <div
      className={cn(
        "relative h-full min-h-[500px] min-w-0 overflow-hidden rounded-xl border bg-background",
        !definition.nodes.length && "grid place-items-center",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={dropNode}
    >
      {!definition.nodes.length ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <EmptyState
            description="Abra “Adicionar etapa” e escolha um gatilho para começar."
            title="Construa seu primeiro fluxo"
          />
        </div>
      ) : null}
      <ReactFlow<AutomationFlowNode, AutomationFlowEdge>
        colorMode="light"
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={["Backspace", "Delete"]}
        edges={flowEdges}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        minZoom={0.35}
        nodes={renderedNodes}
        nodeTypes={nodeTypes}
        onConnect={connect}
        onEdgesChange={changeEdges}
        onInit={(instance) => {
          instanceRef.current = instance;
        }}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodesChange={changeNodes}
        onPaneClick={() => onSelectNode(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border)" gap={22} size={1.2} variant={BackgroundVariant.Dots} />
        <Controls className="!overflow-hidden !rounded-lg !border !border-border !shadow-sm" />
        <MiniMap
          className="!rounded-lg !border !border-border !bg-card max-[760px]:!hidden"
          maskColor="color-mix(in oklch, var(--muted), transparent 20%)"
          nodeColor="var(--primary)"
        />
        {dryRunOpen ? (
          <Panel className="!m-3" position="top-right">
            <DryRunPanel
              execution={dryRun}
              error={dryRunError}
              nodeLabels={nodeLabels}
              onClose={onCloseDryRun}
              onRunAgain={onRunDryRun}
              running={dryRunRunning}
            />
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}
