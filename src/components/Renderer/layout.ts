import { Edge, Node } from "@xyflow/react";
import ElkConstructor, { ELK, ElkNode, LayoutOptions } from "elkjs/lib/elk-api";
import {
  isArraySchemaField,
  isDefaultSchemaField,
  isFunctionSchemaField,
  isGenericSchemaField,
  isUnionSchemaField,
  Model,
  TypeAliasModel,
  TypeTextSegment,
} from "../../lib/parser/model-types";
import { EMPTY_BADGE_HUB_IDS } from "./badge-hubs";

export const LAYOUT_RESET_NODE_OVERLAP_THRESHOLD = 0.7;
export const LAYOUT_RESET_NODE_COUNT_CHANGE_THRESHOLD = 0.25;

let elk: ELK | null = null;
const getElk = () => {
  elk ??= new ElkConstructor({
    workerFactory: () => new Worker(new URL("./elk.worker.ts", import.meta.url), { type: "module" }),
  });
  return elk;
};

export type LayoutDirection = "horizontal" | "vertical";
export type LayoutPreset = "anchored" | "fresh" | "legacy";
export type ModelNodeState = Node<{
  model: Model;
  /** The models without a node: badge hubs, collapsed leaves, and models outside the view. */
  badgeHubIds: ReadonlySet<string>;
  /** The subset of `badgeHubIds` that renders as inline text instead of a pill. */
  collapsedLeafIds: ReadonlySet<string>;
}>;
/** The boundary that is drawn behind the nodes of one section. It is derived after the layout. */
export type SectionNodeState = Node<{ title: string }, "section">;
export type RendererNodeState = ModelNodeState | SectionNodeState;

export const isModelNode = (node: RendererNodeState): node is ModelNodeState => node.type === "model";

type LayoutEdgeKind =
  | "dependency"
  | "extends"
  | "field-array"
  | "field-function-arg"
  | "field-function-return"
  | "field-generic"
  | "field-union"
  | "field"
  | "implements";

export type ModelEdgeData = {
  layoutKind: LayoutEdgeKind;
};

export type ModelEdge = Edge<ModelEdgeData>;

type SharedModelEdgeProps = Omit<Partial<ModelEdge>, "data">;

type CreateModelEdgeArgs = {
  id: string;
  layoutKind: LayoutEdgeKind;
  source: string;
  sourceHandle?: string;
  target: string;
};

type LayoutMetricsRelationship = {
  euclideanDistance: number;
  horizontalDistance: number;
  manhattanDistance: number;
  source: string;
  target: string;
  verticalDistance: number;
};

type GetLayoutMetricsArgs = {
  edges: Pick<ModelEdge, "source" | "target">[];
  nodes: Pick<ModelNodeState, "id" | "measured" | "position">[];
};

type ShouldResetLayoutAnchorsArgs = {
  countChangeThreshold?: number;
  nextDocumentId: string;
  nextNodeIds: Iterable<string>;
  overlapThreshold?: number;
  previousDocumentId?: string;
  previousNodeIds: Iterable<string>;
};

type LayoutModelNodesArgs = {
  compact?: boolean;
  direction: LayoutDirection;
  edges: ModelEdge[];
  manuallyMovedNodesSet: Set<string>;
  nodes: ModelNodeState[];
  /** The section id per node id. Each section becomes an elk compound node. */
  groups?: ReadonlyMap<string, string> | null;
  /** The elk partition per node id. Elk ignores partitions unless every node has one. */
  partitions?: ReadonlyMap<string, number> | null;
  preset?: LayoutPreset;
};

const createModelEdge = ({
  id,
  layoutKind,
  source,
  sourceHandle,
  target,
}: CreateModelEdgeArgs): ModelEdge => ({
  data: { layoutKind },
  id,
  source,
  ...(sourceHandle ? { sourceHandle } : {}),
  target,
});

const requireLayoutKind = (edge: ModelEdge) => {
  const layoutKind = edge.data?.layoutKind;
  if (!layoutKind) throw new Error(`Missing layoutKind for edge: ${edge.id}`);
  return layoutKind;
};

export const UNPLACED_NODE_POSITION = { x: -1, y: -1 } as const;

export const isUnplacedNode = (node: Pick<Node, "position">) =>
  node.position.x === UNPLACED_NODE_POSITION.x && node.position.y === UNPLACED_NODE_POSITION.y;

export const extractModelNodes = (
  models: Model[],
  badgeHubIds: ReadonlySet<string> = EMPTY_BADGE_HUB_IDS,
  collapsedLeafIds: ReadonlySet<string> = EMPTY_BADGE_HUB_IDS
): ModelNodeState[] => {
  return models
    .filter((model) => !badgeHubIds.has(model.id))
    .map((model) => ({
      data: { model, badgeHubIds, collapsedLeafIds },
      id: model.id,
      position: UNPLACED_NODE_POSITION,
      type: "model",
    }));
};

/** Leaf text has only primitives, literals, references, and punctuation. An object type has words. */
const isLeafText = (segments: TypeTextSegment[] | undefined) =>
  segments !== undefined &&
  segments.every((segment) => segment.kind !== "default" || !/[A-Za-z]/.test(segment.text));

/**
 * A leaf is a type alias with 1 `==>` row that names no other model. A generic
 * utility such as `Brand<T, Name>` is the exception: `Brand<string, "EmployeeId">`
 * is a leaf. The row is a primitive, a literal union, or text of those.
 */
export const isLeafModel = (model: Model): model is TypeAliasModel => {
  if (model.type !== "typeAlias" || model.arguments.length > 0 || model.schema.length !== 1) return false;
  const [row] = model.schema;
  if (row.name !== "==>") return false;
  if (!model.dependencies.every((dependency) => dependency.arguments.length > 0)) return false;
  const texts = isUnionSchemaField(row) ? row.types : isDefaultSchemaField(row) ? [row.type] : [];
  if (texts.length === 0) return false;
  return texts.every((text) => typeof text === "string" && isLeafText(model.typeTextSegments[text]));
};

/** The declared type of a leaf, for example `Brand<string, "EmployeeId">` or `"a" | "b"`. */
export const describeLeafType = (model: TypeAliasModel): string => {
  const [row] = model.schema;
  if (isUnionSchemaField(row))
    return row.types.map((type) => (typeof type === "string" ? type : type.name)).join(" | ");
  return typeof row.type === "string" ? row.type : row.type.name;
};

/** The leaves that at least 1 other model references. They get no node and no edges. */
export const selectCollapsedLeafIds = (models: Model[]): Set<string> => {
  const ids = new Set<string>();
  for (const model of models) if (isLeafModel(model) && model.dependants.length > 0) ids.add(model.id);
  return ids;
};

export const fieldHasSourceEdge = (
  field: Model["schema"][number],
  badgeHubIds: ReadonlySet<string>
): boolean => {
  const refersToNode = (value: Model | string | undefined): boolean =>
    value instanceof Object && !badgeHubIds.has(value.id);
  if (field.typeRefs?.some((typeRef) => !badgeHubIds.has(typeRef.id))) return true;
  if (isArraySchemaField(field)) return refersToNode(field.elementType);
  if (isGenericSchemaField(field)) return field.arguments.some(refersToNode);
  if (isFunctionSchemaField(field)) {
    if (field.arguments.some((argument) => refersToNode(argument.type))) return true;
    return Array.isArray(field.returnType)
      ? refersToNode(field.returnType[0])
      : refersToNode(field.returnType);
  }
  if (isUnionSchemaField(field)) return field.types.some(refersToNode);
  return refersToNode(field.type);
};

export const getTypeAliasHeaderDependencies = (model: TypeAliasModel) => {
  const fieldTargets = new Set(
    model.schema.flatMap((field) => {
      const targets: string[] = [];
      if (field.type instanceof Object) targets.push(field.type.id);
      if (isArraySchemaField(field) && field.elementType instanceof Object) {
        targets.push(field.elementType.id);
      }
      if (isGenericSchemaField(field)) {
        for (const argument of field.arguments) if (argument instanceof Object) targets.push(argument.id);
      }
      if (isFunctionSchemaField(field)) {
        for (const argument of field.arguments) {
          if (argument.type instanceof Object) targets.push(argument.type.id);
        }
        const returnType = Array.isArray(field.returnType) ? field.returnType[0] : field.returnType;
        if (returnType instanceof Object) targets.push(returnType.id);
      }
      if (isUnionSchemaField(field)) {
        for (const type of field.types) if (type instanceof Object) targets.push(type.id);
      }
      for (const typeRef of field.typeRefs ?? []) targets.push(typeRef.id);
      return targets;
    })
  );
  return model.dependencies.filter((dependency) => !fieldTargets.has(dependency.id));
};

export const extractModelEdges = (
  models: Model[],
  badgeHubIds: ReadonlySet<string> = EMPTY_BADGE_HUB_IDS
): ModelEdge[] => {
  const result: ModelEdge[] = [];

  // stable, content-derived edge ids: a structural edit renumbers nothing, so unchanged
  // edge objects keep their identity (and their published routes) across reparses
  const usedEdgeIds = new Map<string, number>();
  const uniqueEdgeId = (base: string) => {
    const occurrence = usedEdgeIds.get(base) ?? 0;
    usedEdgeIds.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}~${occurrence}`;
  };
  for (const model of models) {
    if (model.type === "interface") {
      for (const extended of model.extends) {
        if (extended instanceof Object) {
          result.push(
            createModelEdge({
              id: uniqueEdgeId(`extends-${model.id}-${extended.id}`),
              layoutKind: "extends",
              source: model.id,
              target: extended.id,
            })
          );
        }
      }
    }

    if (model.type === "typeAlias") {
      for (const dependency of getTypeAliasHeaderDependencies(model)) {
        result.push(
          createModelEdge({
            id: uniqueEdgeId(`dep-${model.id}-${dependency.id}`),
            layoutKind: "dependency",
            source: model.id,
            target: dependency.id,
          })
        );
      }
    }

    if (model.type === "class") {
      if (model.extends instanceof Object) {
        result.push(
          createModelEdge({
            id: uniqueEdgeId(`extends-${model.id}-${model.extends.id}`),
            layoutKind: "extends",
            source: model.id,
            target: model.extends.id,
          })
        );
      }

      for (const implemented of model.implements) {
        if (implemented instanceof Object) {
          result.push(
            createModelEdge({
              id: uniqueEdgeId(`implements-${model.id}-${implemented.id}`),
              layoutKind: "implements",
              source: model.id,
              target: implemented.id,
            })
          );
        }
      }
    }

    if ((model.type === "class" || model.type === "interface") && model.headerRefs) {
      for (const headerRef of model.headerRefs) {
        result.push(
          createModelEdge({
            id: uniqueEdgeId(`heritage-${model.id}-${headerRef.id}`),
            layoutKind: "extends",
            source: model.id,
            target: headerRef.id,
          })
        );
      }
    }

    for (const field of model.schema) {
      if (field.type instanceof Object) {
        result.push(
          createModelEdge({
            id: uniqueEdgeId(`field-${model.id}-${field.name}`),
            layoutKind: "field",
            source: model.id,
            sourceHandle: `${model.id}-source-${field.name}`,
            target: field.type.id,
          })
        );
      }

      if (isArraySchemaField(field) && field.elementType instanceof Object) {
        result.push(
          createModelEdge({
            id: uniqueEdgeId(`fieldarr-${model.id}-${field.name}`),
            layoutKind: "field-array",
            source: model.id,
            sourceHandle: `${model.id}-source-${field.name}`,
            target: field.elementType.id,
          })
        );
      }

      if (isGenericSchemaField(field)) {
        for (const argument of field.arguments) {
          if (argument instanceof Object) {
            result.push(
              createModelEdge({
                id: uniqueEdgeId(`fieldgen-${model.id}-${field.name}-${argument.id}`),
                layoutKind: "field-generic",
                source: model.id,
                sourceHandle: `${model.id}-source-${field.name}`,
                target: argument.id,
              })
            );
          }
        }
      }

      if (isFunctionSchemaField(field)) {
        for (const argument of field.arguments) {
          if (argument.type instanceof Object) {
            result.push(
              createModelEdge({
                id: uniqueEdgeId(`fnarg-${model.id}-${field.name}-${argument.type.id}`),
                layoutKind: "field-function-arg",
                source: model.id,
                sourceHandle: `${model.id}-source-${field.name}`,
                target: argument.type.id,
              })
            );
          }
        }

        const returnType = Array.isArray(field.returnType) ? field.returnType[0] : field.returnType;
        if (returnType instanceof Object) {
          result.push(
            createModelEdge({
              id: uniqueEdgeId(`fnret-${model.id}-${field.name}-${returnType.id}`),
              layoutKind: "field-function-return",
              source: model.id,
              sourceHandle: `${model.id}-source-${field.name}`,
              target: returnType.id,
            })
          );
        }
      }

      if (field.typeRefs) {
        for (const typeRef of field.typeRefs) {
          result.push(
            createModelEdge({
              id: uniqueEdgeId(`fieldref-${model.id}-${field.name}-${typeRef.id}`),
              layoutKind: "field",
              source: model.id,
              sourceHandle: `${model.id}-source-${field.name}`,
              target: typeRef.id,
            })
          );
        }
      }

      if (isUnionSchemaField(field)) {
        for (const unionType of field.types) {
          if (unionType instanceof Object) {
            result.push(
              createModelEdge({
                id: uniqueEdgeId(`fieldunion-${model.id}-${field.name}-${unionType.id}`),
                layoutKind: "field-union",
                source: model.id,
                sourceHandle: `${model.id}-source-${field.name}`,
                target: unionType.id,
              })
            );
          }
        }
      }
    }
  }
  // badge hubs have no node; every edge touching one is represented by its inline pill
  return result.filter((edge) => !badgeHubIds.has(edge.source) && !badgeHubIds.has(edge.target));
};

export const decorateModelEdges = (
  edges: ModelEdge[],
  sharedEdgeProps: SharedModelEdgeProps = {}
): ModelEdge[] => {
  return edges.map((edge) => ({
    ...edge,
    ...sharedEdgeProps,
    data: {
      ...edge.data,
      layoutKind: requireLayoutKind(edge),
    },
  }));
};

const getLayoutEdgePriority = (edge: ModelEdge) => {
  let priority = 0;
  if (edge.data?.layoutKind !== "dependency") priority += 1;
  if (edge.sourceHandle) priority += 2;
  return priority;
};

export const normalizeLayoutEdges = (edges: ModelEdge[]): ModelEdge[] => {
  const edgesByPair = new Map<
    string,
    {
      edge: ModelEdge;
      firstIndex: number;
      priority: number;
    }
  >();

  for (const [index, edge] of edges.entries()) {
    const key = `${edge.source}=>${edge.target}`;
    const priority = getLayoutEdgePriority(edge);
    const existing = edgesByPair.get(key);

    if (!existing) {
      edgesByPair.set(key, { edge, firstIndex: index, priority });
      continue;
    }

    if (priority > existing.priority) {
      edgesByPair.set(key, { edge, firstIndex: existing.firstIndex, priority });
    }
  }

  return Array.from(edgesByPair.values())
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ edge }) => edge);
};

const getLayoutOptions = (direction: LayoutDirection, preset: LayoutPreset): LayoutOptions => {
  if (preset === "legacy") {
    return {
      "elk.algorithm": "layered",
      "elk.direction": direction === "horizontal" ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.insideSelfLoops.activate": "false",
      "elk.interactiveLayout": "true",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.nodePlacement.strategy": "LINEAR_SEGMENTS",
      "elk.layered.spacing.edgeNodeBetweenLayers": "25",
      "elk.layered.spacing.nodeNodeBetweenLayers": "50",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "100",
      "elk.spacing.nodeNode": "50",
    };
  }

  const compactOptions: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.aspectRatio": "1.6",
    "elk.direction": direction === "horizontal" ? "RIGHT" : "DOWN",
    "elk.edgeRouting": "POLYLINE",
    "elk.insideSelfLoops.activate": "false",
    "elk.layered.mergeEdges": "true",
    "elk.layered.compaction.postCompaction.strategy": "LEFT",
    "elk.layered.nodePlacement.strategy": "LINEAR_SEGMENTS",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
    "elk.layered.spacing.edgeNodeBetweenLayers": "20",
    "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    "elk.spacing.componentComponent": "64",
    "elk.spacing.edgeEdge": "10",
    "elk.spacing.edgeNode": "20",
    "elk.spacing.nodeNode": "72",
  };

  if (preset === "anchored") {
    return {
      ...compactOptions,
      "elk.interactiveLayout": "true",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.layering.strategy": "INTERACTIVE",
      "elk.separateConnectedComponents": "false",
    };
  }

  return {
    ...compactOptions,
    "elk.interactiveLayout": "false",
    "elk.layered.crossingMinimization.semiInteractive": "false",
    "elk.layered.cycleBreaking.strategy": "GREEDY",
    "elk.separateConnectedComponents": "true",
  };
};

export const getLayoutPreset = (manuallyMovedNodesSet: Set<string>): LayoutPreset => {
  return manuallyMovedNodesSet.size > 0 ? "anchored" : "fresh";
};

const NO_PINNED_IDS: ReadonlySet<string> = new Set();

/** Room inside a section box: the title needs the top. The drawn boundary uses the same padding. */
const SECTION_PAD_PX = 24;
const SECTION_TITLE_PAD_PX = 40;

export const layoutModelNodes = async ({
  compact,
  direction,
  edges,
  groups,
  manuallyMovedNodesSet,
  nodes,
  partitions,
  preset,
}: LayoutModelNodesArgs): Promise<ModelNodeState[]> => {
  const resolvedPreset = preset ?? getLayoutPreset(manuallyMovedNodesSet);
  // partitions and groups order the whole graph, so the components must share one layout
  const elkOptions: LayoutOptions = {
    ...getLayoutOptions(direction, resolvedPreset),
    ...(partitions ? { "elk.partitioning.activate": "true" } : {}),
    ...(groups ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
    ...(partitions || groups ? { "elk.separateConnectedComponents": "false" } : {}),
  };

  // a pinned node inside a group is pinned relative to the group, so the group
  // starts at the top left corner of its current members
  const groupOrigins = new Map<string, { x: number; y: number }>();
  if (groups && resolvedPreset === "anchored") {
    for (const node of nodes) {
      const groupId = groups.get(node.id);
      if (!groupId) continue;
      const origin = groupOrigins.get(groupId) ?? { x: Infinity, y: Infinity };
      origin.x = Math.min(origin.x, node.position.x);
      origin.y = Math.min(origin.y, node.position.y);
      groupOrigins.set(groupId, origin);
    }
  }

  const toElkNode = (node: ModelNodeState): ElkNode => {
    const isPinned = manuallyMovedNodesSet.has(node.id);
    const origin = groupOrigins.get(groups?.get(node.id) ?? "") ?? { x: 0, y: 0 };

    // overload rows share a field name, so ports are deduped by id
    const ports = new Map<string, { id: string; order: number; properties: Record<string, string> }>();
    for (const [index, field] of node.data.model.schema.entries()) {
      const portId = `${node.id}-source-${field.name}`;
      if (ports.has(portId)) continue;
      ports.set(portId, {
        id: portId,
        order: index,
        properties: {
          "port.side": "EAST",
        },
      });
    }

    return {
      height: node.measured?.height ?? 0,
      id: node.id,
      ...(partitions
        ? { layoutOptions: { "elk.partitioning.partition": String(partitions.get(node.id) ?? 0) } }
        : {}),
      ports: [...ports.values()],
      ...(resolvedPreset === "anchored" && isPinned
        ? {
            x: node.position.x - origin.x,
            y: node.position.y - origin.y,
          }
        : {}),
      width: node.measured?.width ?? 0,
    };
  };

  const children: ElkNode[] = [];
  const groupChildren = new Map<string, ElkNode[]>();
  for (const node of nodes) {
    const groupId = groups?.get(node.id);
    if (!groupId) {
      children.push(toElkNode(node));
      continue;
    }
    let members = groupChildren.get(groupId);
    if (!members) {
      members = [];
      groupChildren.set(groupId, members);
      const origin = groupOrigins.get(groupId);
      children.push({
        children: members,
        id: `group:${groupId}`,
        layoutOptions: {
          "elk.padding": `[top=${SECTION_TITLE_PAD_PX},left=${SECTION_PAD_PX},bottom=${SECTION_PAD_PX},right=${SECTION_PAD_PX}]`,
        },
        ...(origin ? { x: origin.x, y: origin.y } : {}),
      });
    }
    members.push(toElkNode(node));
  }

  const graph: ElkNode = {
    children,
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.sourceHandle ?? edge.source],
      targets: [edge.target],
    })),
    id: "root",
    layoutOptions: elkOptions,
  };

  const layoutedGraph = await getElk().layout(graph, { layoutOptions: elkOptions });
  // a child of a group has coordinates relative to the group
  const layoutedPositions = new Map<string, { x: number; y: number }>();
  const collectPositions = (parent: ElkNode, offsetX: number, offsetY: number) => {
    for (const child of parent.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      layoutedPositions.set(child.id, { x, y });
      collectPositions(child, x, y);
    }
  };
  collectPositions(layoutedGraph, 0, 0);

  const layoutedNodes = nodes.map((node) => {
    const layoutedPosition = layoutedPositions.get(node.id);
    if (!layoutedPosition) return node;

    const isPinned = resolvedPreset === "anchored" && manuallyMovedNodesSet.has(node.id);

    return {
      ...node,
      position: isPinned ? node.position : layoutedPosition,
    };
  });

  if (!compact) return layoutedNodes;
  const pinnedIds = resolvedPreset === "anchored" ? manuallyMovedNodesSet : NO_PINNED_IDS;
  if (!groups) return compactLayoutedNodes({ direction, nodes: layoutedNodes, pinnedIds });
  // compaction per group keeps every node inside its section box
  const nodesByGroup = new Map<string, ModelNodeState[]>();
  for (const node of layoutedNodes) {
    const groupId = groups.get(node.id) ?? "";
    nodesByGroup.set(groupId, [...(nodesByGroup.get(groupId) ?? []), node]);
  }
  const compacted = new Map<string, ModelNodeState>();
  for (const groupNodes of nodesByGroup.values()) {
    for (const node of compactLayoutedNodes({ direction, nodes: groupNodes, pinnedIds })) {
      compacted.set(node.id, node);
    }
  }
  return layoutedNodes.map((node) => compacted.get(node.id) ?? node);
};

/**
 * The functions view: the functions and the models that their signatures
 * reference directly. A function's dependencies are its parameter types, its
 * return type, and the type arguments of those.
 */
export const selectFunctionsView = (models: Model[]): Model[] => {
  const visible = new Set<Model>();
  for (const model of models) {
    if (model.type !== "function") continue;
    visible.add(model);
    for (const dependency of model.dependencies) visible.add(dependency);
  }
  return models.filter((model) => visible.has(model));
};

/** The source order of each function as its partition. A type joins the first function that uses it. */
export const computeFunctionPartitions = (models: Model[]): Map<string, number> => {
  const partitions = new Map<string, number>();
  let order = 0;
  for (const model of models) {
    if (model.type !== "function") continue;
    partitions.set(model.id, order);
    for (const dependency of model.dependencies) {
      if (!partitions.has(dependency.id)) partitions.set(dependency.id, order);
    }
    order += 1;
  }
  return partitions;
};

/** The section id per model id, or null when no model has a section. */
export const computeSectionGroups = (models: Model[]): Map<string, string> | null => {
  const groups = new Map<string, string>();
  for (const model of models) if (model.section) groups.set(model.id, model.section.id);
  return groups.size > 0 ? groups : null;
};

/**
 * One boundary node per section, sized to the placed and measured member
 * nodes plus padding. The boundary takes no pointer events and no layout.
 */
export const buildSectionNodes = (nodes: ModelNodeState[]): SectionNodeState[] => {
  const boxes = new Map<
    string,
    { title: string; order: number; left: number; top: number; right: number; bottom: number }
  >();
  for (const node of nodes) {
    const { section } = node.data.model;
    if (!section || isUnplacedNode(node) || !node.measured?.width || !node.measured.height) continue;
    const box = boxes.get(section.id) ?? {
      title: section.title,
      order: section.order,
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity,
    };
    box.left = Math.min(box.left, node.position.x);
    box.top = Math.min(box.top, node.position.y);
    box.right = Math.max(box.right, node.position.x + node.measured.width);
    box.bottom = Math.max(box.bottom, node.position.y + node.measured.height);
    boxes.set(section.id, box);
  }
  return [...boxes.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id, box]) => {
      const width = box.right - box.left + SECTION_PAD_PX * 2;
      const height = box.bottom - box.top + SECTION_PAD_PX + SECTION_TITLE_PAD_PX;
      return {
        connectable: false,
        data: { title: box.title },
        draggable: false,
        focusable: false,
        height,
        id: `section:${id}`,
        measured: { height, width },
        position: { x: box.left - SECTION_PAD_PX, y: box.top - SECTION_TITLE_PAD_PX },
        selectable: false,
        type: "section",
        width,
        zIndex: -1,
      };
    });
};

const COMPACT_PAD_PX = 72;
const COMPACT_ASPECT_CAP = 1.7;

type CompactBox = {
  h: number;
  id: string;
  pinned: boolean;
  w: number;
  x: number;
  y: number;
};

const transposeBoxes = (boxes: CompactBox[]) => {
  for (const box of boxes) {
    [box.x, box.y] = [box.y, box.x];
    [box.w, box.h] = [box.h, box.w];
  }
};

const groupLayers = (boxes: CompactBox[]) => {
  const ordered = [...boxes].sort((a, b) => a.x - b.x);
  const layers: CompactBox[][] = [];
  let right = -Infinity;
  for (const box of ordered) {
    if (layers.length === 0 || box.x >= right) layers.push([]);
    layers[layers.length - 1].push(box);
    right = Math.max(right, box.x + box.w);
  }
  return layers;
};

const slideUp = (boxes: CompactBox[], pad: number, layoutTop: number): Map<string, number> => {
  const shifts = new Map<string, number>();
  const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const box of ordered) {
    if (box.pinned) continue;
    let ceiling = layoutTop;
    for (const other of ordered) {
      if (other === box) continue;
      const overlapsX = other.x < box.x + box.w + pad && box.x < other.x + other.w + pad;
      if (!overlapsX) continue;
      if (other.y + other.h <= box.y) ceiling = Math.max(ceiling, other.y + other.h + pad);
    }
    const shift = box.y - ceiling;
    if (shift <= 0) continue;
    box.y = ceiling;
    shifts.set(box.id, shift);
  }
  return shifts;
};

const getBoxBounds = (boxes: CompactBox[]) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { height: maxY - minY, top: minY, width: maxX - minX };
};

type CompactLayoutedNodesArgs = {
  aspectCap?: number;
  direction: LayoutDirection;
  nodes: ModelNodeState[];
  pad?: number;
  pinnedIds: ReadonlySet<string>;
};

export const compactLayoutedNodes = ({
  aspectCap = COMPACT_ASPECT_CAP,
  direction,
  nodes,
  pad = COMPACT_PAD_PX,
  pinnedIds,
}: CompactLayoutedNodesArgs): ModelNodeState[] => {
  if (nodes.length < 2) return nodes;
  if (nodes.some((node) => !node.measured?.width || !node.measured.height)) return nodes;

  const boxes: CompactBox[] = nodes.map((node) => ({
    h: node.measured?.height ?? 0,
    id: node.id,
    pinned: pinnedIds.has(node.id),
    w: node.measured?.width ?? 0,
    x: node.position.x,
    y: node.position.y,
  }));

  // vertical layouts flow down; transposing makes the same pass (and the same aspect
  // cap, now on height/width) apply to their in-layer axis
  if (direction === "vertical") transposeBoxes(boxes);

  const originalY = new Map(boxes.map((box) => [box.id, box.y]));
  const { top, width } = getBoxBounds(boxes);
  const shifts = new Map<string, number>();
  for (const layer of groupLayers(boxes)) {
    for (const [id, shift] of slideUp(layer, pad, top)) shifts.set(id, shift);
  }
  const heightAt = (scale: number) => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const box of boxes) {
      const y = (originalY.get(box.id) ?? box.y) - scale * (shifts.get(box.id) ?? 0);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + box.h);
    }
    return maxY - minY;
  };
  if (width / heightAt(1) > aspectCap) {
    let low = 0;
    let high = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (width / heightAt(mid) > aspectCap) high = mid;
      else low = mid;
    }
    for (const box of boxes) {
      const shift = shifts.get(box.id);
      if (shift) box.y = (originalY.get(box.id) ?? box.y) - low * shift;
    }
  }

  if (direction === "vertical") transposeBoxes(boxes);

  const boxById = new Map(boxes.map((box) => [box.id, box]));
  return nodes.map((node) => {
    const box = boxById.get(node.id);
    if (!box || (box.x === node.position.x && box.y === node.position.y)) return node;
    return { ...node, position: { x: box.x, y: box.y } };
  });
};

export const getNodeIdOverlapRatio = (previousNodeIds: Iterable<string>, nextNodeIds: Iterable<string>) => {
  const previousNodeIdSet = new Set(previousNodeIds);
  const nextNodeIdSet = new Set(nextNodeIds);
  const denominator = Math.max(previousNodeIdSet.size, nextNodeIdSet.size);
  if (denominator === 0) return 1;

  let overlapCount = 0;
  for (const nodeId of nextNodeIdSet) {
    if (previousNodeIdSet.has(nodeId)) overlapCount += 1;
  }

  return overlapCount / denominator;
};

export const getNodeCountChangeRatio = (previousNodeIds: Iterable<string>, nextNodeIds: Iterable<string>) => {
  const previousNodeIdSet = new Set(previousNodeIds);
  const nextNodeIdSet = new Set(nextNodeIds);
  const denominator = Math.max(previousNodeIdSet.size, nextNodeIdSet.size);
  if (denominator === 0) return 0;
  return Math.abs(previousNodeIdSet.size - nextNodeIdSet.size) / denominator;
};

export const shouldResetLayoutAnchors = ({
  countChangeThreshold = LAYOUT_RESET_NODE_COUNT_CHANGE_THRESHOLD,
  nextDocumentId,
  nextNodeIds,
  overlapThreshold = LAYOUT_RESET_NODE_OVERLAP_THRESHOLD,
  previousDocumentId,
  previousNodeIds,
}: ShouldResetLayoutAnchorsArgs) => {
  if (!previousDocumentId) return false;
  if (previousDocumentId !== nextDocumentId) return true;

  if (getNodeIdOverlapRatio(previousNodeIds, nextNodeIds) < overlapThreshold) return true;
  if (getNodeCountChangeRatio(previousNodeIds, nextNodeIds) > countChangeThreshold) return true;

  return false;
};

const getMedian = (values: number[]) => {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middleIndex];
  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
};

export const getLayoutMetrics = ({ edges, nodes }: GetLayoutMetricsArgs) => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const relationships: LayoutMetricsRelationship[] = [];
  for (const edge of edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sourceWidth = sourceNode.measured?.width ?? 0;
    const sourceHeight = sourceNode.measured?.height ?? 0;
    const targetWidth = targetNode.measured?.width ?? 0;
    const targetHeight = targetNode.measured?.height ?? 0;
    const horizontalDistance =
      targetNode.position.x + targetWidth / 2 - (sourceNode.position.x + sourceWidth / 2);
    const verticalDistance =
      targetNode.position.y + targetHeight / 2 - (sourceNode.position.y + sourceHeight / 2);

    relationships.push({
      euclideanDistance: Math.hypot(horizontalDistance, verticalDistance),
      horizontalDistance: Math.abs(horizontalDistance),
      manhattanDistance: Math.abs(horizontalDistance) + Math.abs(verticalDistance),
      source: edge.source,
      target: edge.target,
      verticalDistance: Math.abs(verticalDistance),
    });
  }

  const manhattanDistances = relationships.map((relationship) => relationship.manhattanDistance);
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + (node.measured?.width ?? 0)));
  const maxY = Math.max(...nodes.map((node) => node.position.y + (node.measured?.height ?? 0)));

  return {
    averageManhattanDistance:
      manhattanDistances.reduce((sum, value) => sum + value, 0) / Math.max(manhattanDistances.length, 1),
    edgeCount: relationships.length,
    height: maxY - minY,
    medianManhattanDistance: getMedian(manhattanDistances),
    relationships,
    width: maxX - minX,
  };
};
