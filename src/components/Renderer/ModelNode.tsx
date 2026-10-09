import { memo, ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import classNames from "classnames";
import {
  FunctionSchemaField,
  InlineObjectMember,
  isArraySchemaField,
  isDefaultSchemaField,
  isFunctionSchemaField,
  isGenericSchemaField,
  isInlineObjectMember,
  isObjectSchemaField,
  isUnionSchemaField,
  Model,
  SchemaField,
  TypeTextSegment,
  UnionSchemaField,
} from "../../lib/parser/model-types";
import { graphStore, useIsBadgeHubHovered, useNodeDecoration } from "../../stores/graph";
import { describeLeafType, fieldHasSourceEdge, getTypeAliasHeaderDependencies, isLeafModel } from "./layout";
import { usePortColor } from "./port-colors";

export type ModelNodeProps = {
  id: string;
  data: { model: Model; badgeHubIds: ReadonlySet<string>; collapsedLeafIds: ReadonlySet<string> };
};

const isTextOrModel = (value: InlineObjectMember | Model | string): value is Model | string =>
  !isInlineObjectMember(value);

const isModelReference = (value: unknown): value is Model => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Model>;
  return typeof candidate.name === "string" && typeof candidate.type === "string";
};

const MODEL_NODE_CLASSES = {
  root: "max-w-md rounded-lg border shadow-(--shadow-card)",
  field: {
    root: "text-body [&+tr>td]:border-t [&+tr>td]:border-divider",
    keyCell: "py-1 pr-4 pl-2 text-text align-top",
    inheritedName: "text-text-faint",
    typeCell: "relative py-1 pr-2 break-words",
    defaultTypeColor: "text-text-faint",
    modelTypeColor: "text-accent",
    primitiveTypeColor: "text-text-muted",
    literalTypeColor: "text-code-literal",
  },
  /** The box of an inline object: a small node inside the row, with its own header bar. */
  nested: {
    root: "my-1 overflow-hidden rounded-md border border-border bg-pane",
    header: "min-h-1.5 bg-brand px-1.5 py-0.5 text-xs font-strong text-brand-fg",
    keyCell: "py-0.5 pr-3 pl-1.5 text-text align-top whitespace-nowrap",
    typeCell: "relative py-0.5 pr-1.5 break-words",
  },
} as const;

const SourcePort = ({ portId }: { portId: string }) => {
  const color = usePortColor(portId) ?? "var(--color-accent)";
  return (
    <svg className="model-node-port" aria-hidden>
      <circle className="fill-pane" cx="4" cy="4" r="3.6" />
      <circle className="fill-pane" cx="4" cy="4" r="2.4" stroke={color} strokeWidth="1.2" />
    </svg>
  );
};
const TargetPort = ({ portId }: { portId: string }) => {
  const color = usePortColor(portId) ?? "var(--color-accent)";
  return (
    <svg className="model-node-port" aria-hidden>
      <circle className="fill-pane" cx="4" cy="4" r="3.6" />
      <circle cx="4" cy="4" fill={color} r="3" />
    </svg>
  );
};

const HubBadgePill = ({ refModel }: { refModel: Model }) => {
  const pillId = useId();
  const isHovered = useIsBadgeHubHovered(refModel.id);
  // a reparse can unmount the hovered pill without a mouseleave; clear the hub hover so
  // the remaining pills of the hub do not stay highlighted
  useEffect(() => {
    return () => {
      graphStore.state.clearHoveredBadgeHub(pillId);
    };
  }, [pillId]);
  const handleMouseEnter = () => {
    graphStore.state.setHoveredBadgeHub(refModel.id, pillId);
  };
  const handleMouseLeave = () => {
    graphStore.state.clearHoveredBadgeHub(pillId);
  };
  return (
    <span
      className={classNames(
        "cursor-default rounded-sm px-[5px] py-px text-micro font-medium",
        isHovered ? "bg-selection-hover" : "bg-inset",
        MODEL_NODE_CLASSES.field.modelTypeColor
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {refModel.name}
    </span>
  );
};

/** A collapsed leaf has no node, so its name carries the declared type for a hover. */
const LeafNameSpan = ({ refModel }: { refModel: Model }) => (
  <span
    className={MODEL_NODE_CLASSES.field.modelTypeColor}
    title={isLeafModel(refModel) ? describeLeafType(refModel) : undefined}
  >
    {refModel.name}
  </span>
);

type TypeNameSpanProps = {
  badgeHubIds: ReadonlySet<string>;
  collapsedLeafIds: ReadonlySet<string>;
  refModel: Model;
};

const TypeNameSpan = ({ badgeHubIds, collapsedLeafIds, refModel }: TypeNameSpanProps) => {
  if (collapsedLeafIds.has(refModel.id)) return <LeafNameSpan refModel={refModel} />;
  if (badgeHubIds.has(refModel.id)) return <HubBadgePill key={refModel.id} refModel={refModel} />;
  return <span className={MODEL_NODE_CLASSES.field.modelTypeColor}>{refModel.name}</span>;
};

const TYPE_TEXT_COLORS = {
  primitive: MODEL_NODE_CLASSES.field.primitiveTypeColor,
  literal: MODEL_NODE_CLASSES.field.literalTypeColor,
  reference: MODEL_NODE_CLASSES.field.modelTypeColor,
};

type TypeTextProps = {
  /** The collapsed leaves this model references, by name. A reference segment to one gets the hover. */
  leavesByName?: ReadonlyMap<string, Model>;
  segments: TypeTextSegment[];
};

const TypeText = ({ leavesByName, segments }: TypeTextProps) => (
  <span className={MODEL_NODE_CLASSES.field.defaultTypeColor}>
    {segments.map((segment, index) => {
      if (segment.kind === "default") return segment.text;
      const leaf = segment.kind === "reference" ? leavesByName?.get(segment.text) : undefined;
      if (leaf) return <LeafNameSpan key={index} refModel={leaf} />;
      return (
        <span key={index} className={TYPE_TEXT_COLORS[segment.kind]}>
          {segment.text}
        </span>
      );
    })}
  </span>
);

type FieldContext = {
  model: Model;
  badgeHubIds: ReadonlySet<string>;
  collapsedLeafIds: ReadonlySet<string>;
  leavesByName: ReadonlyMap<string, Model>;
};

const Muted = ({ children }: { children: ReactNode }) => (
  <span className={MODEL_NODE_CLASSES.field.defaultTypeColor}>{children}</span>
);

/** A model reference as a name or a pill, or a type text with colored segments. */
const TypeValue = ({ context, value }: { context: FieldContext; value: Model | string }) => {
  if (isModelReference(value))
    return (
      <TypeNameSpan
        badgeHubIds={context.badgeHubIds}
        collapsedLeafIds={context.collapsedLeafIds}
        refModel={value}
      />
    );
  return <TypeText leavesByName={context.leavesByName} segments={context.model.typeTextSegments[value]} />;
};

const Separated = ({ items, separator }: { items: ReactNode[]; separator: ReactNode }) => (
  <>
    {items.map((item, index) => (
      <span key={index}>
        {item}
        {index < items.length - 1 && separator}
      </span>
    ))}
  </>
);

const FieldKey = ({ field }: { field: SchemaField }) => (
  <>
    {field.modifiers && field.modifiers.length > 0 && <Muted>{`${field.modifiers.join(" ")} `}</Muted>}
    {isFunctionSchemaField(field) && field.accessor && <Muted>{field.accessor} </Muted>}
    <span className={field.inherited ? MODEL_NODE_CLASSES.field.inheritedName : undefined}>{field.name}</span>
    {field.optional && <Muted>?</Muted>}
  </>
);

/** The parameters above the return type, with a divider between the 2 lines. */
const FunctionStack = ({ context, field }: { context: FieldContext; field: FunctionSchemaField }) => {
  const returnType = Array.isArray(field.returnType) ? field.returnType[0] : field.returnType;
  const returnValue = (
    <>
      {field.returnTypeReadonly && <Muted>readonly </Muted>}
      <TypeValue context={context} value={returnType} />
      {Array.isArray(field.returnType) && <Muted>[]</Muted>}
    </>
  );
  // a signature without parameters stays on 1 line: a lone "()" line is noise
  if (field.arguments.length === 0) {
    return (
      <span>
        <Muted>(): </Muted>
        {returnValue}
      </span>
    );
  }
  return (
    <div className="flex flex-col">
      <div>
        <Muted>(</Muted>
        <Separated
          items={field.arguments.map((argument) => (
            <span key={argument.name}>
              {argument.name}
              <Muted>: </Muted>
              <TypeValue context={context} value={argument.type} />
            </span>
          ))}
          separator={<Muted>, </Muted>}
        />
        <Muted>)</Muted>
      </div>
      <div className="border-t border-divider">{returnValue}</div>
    </div>
  );
};

/**
 * Finds the key that names the members of a union of inline objects: a
 * property that every member has with a string literal type, like `kind`.
 */
const findDiscriminant = (objects: InlineObjectMember[]): string | null => {
  if (objects.length < 2) return null;
  const isLiteralMember = (member: SchemaField) =>
    isDefaultSchemaField(member) &&
    typeof member.type === "string" &&
    /^(["']|true$|false$|-?\d)/.test(member.type);
  const [first] = objects;
  for (const candidate of first.members) {
    if (!isLiteralMember(candidate)) continue;
    const shared = objects.every((object) =>
      object.members.some((member) => member.name === candidate.name && isLiteralMember(member))
    );
    if (shared) return candidate.name;
  }
  return null;
};

const NestedObject = ({
  context,
  members,
  header,
}: {
  context: FieldContext;
  members: SchemaField[];
  header?: ReactNode;
}) => (
  <div className={MODEL_NODE_CLASSES.nested.root}>
    <div className={MODEL_NODE_CLASSES.nested.header}>{header}</div>
    <table className="w-full">
      <tbody>
        {members.map((member, index) => (
          <FieldRow key={`${member.name}-${index}`} context={context} field={member} nested />
        ))}
      </tbody>
    </table>
  </div>
);

/**
 * Inline objects stack as small nodes with an open line between them. The
 * discriminant of the union, for example `kind: "held"`, moves into the
 * header of each box. The other members follow as 1 line of text.
 */
const UnionWithObjects = ({ context, field }: { context: FieldContext; field: UnionSchemaField }) => {
  const objects = field.types.filter(isInlineObjectMember);
  const others = field.types.filter(isTextOrModel);
  const discriminant = findDiscriminant(objects);
  return (
    <div className="flex flex-col gap-1 text-left">
      {objects.map((object, index) => {
        const tag = discriminant ? object.members.find((member) => member.name === discriminant) : undefined;
        const members = tag ? object.members.filter((member) => member !== tag) : object.members;
        const header = tag && isDefaultSchemaField(tag) && (
          <span>
            <span className="opacity-70">{tag.name}: </span>
            {String(tag.type)}
          </span>
        );
        return <NestedObject key={index} context={context} header={header} members={members} />;
      })}
      {others.length > 0 && (
        <Muted>
          <Separated
            items={others.map((type, index) => (
              <TypeValue key={index} context={context} value={type} />
            ))}
            separator=" | "
          />
        </Muted>
      )}
    </div>
  );
};

const FieldType = ({ context, field }: { context: FieldContext; field: SchemaField }) => {
  const readonlyPrefix = isArraySchemaField(field) && field.readonly && <Muted>readonly </Muted>;

  if (isModelReference(field.type)) {
    return (
      <TypeNameSpan
        badgeHubIds={context.badgeHubIds}
        collapsedLeafIds={context.collapsedLeafIds}
        refModel={field.type}
      />
    );
  }
  if (isArraySchemaField(field)) {
    const elementText = isModelReference(field.elementType) ? "" : String(field.elementType);
    const needsParens = elementText.includes("|") || elementText.includes("&");
    return (
      <Muted>
        {readonlyPrefix}
        {needsParens && "("}
        <TypeValue context={context} value={field.elementType} />
        {needsParens && ")"}
        []
      </Muted>
    );
  }
  if (isGenericSchemaField(field)) {
    return (
      <Muted>
        <TypeText
          leavesByName={context.leavesByName}
          segments={context.model.typeTextSegments[field.genericName]}
        />
        {"<"}
        <Separated
          items={field.arguments.map((argument, index) => (
            <TypeValue key={index} context={context} value={argument} />
          ))}
          separator=", "
        />
        {">"}
      </Muted>
    );
  }
  if (isFunctionSchemaField(field)) return <FunctionStack context={context} field={field} />;
  if (isUnionSchemaField(field)) {
    if (field.types.some(isInlineObjectMember)) return <UnionWithObjects context={context} field={field} />;
    const types = field.types.filter(isTextOrModel);
    return (
      <Muted>
        <Separated
          items={types.map((type, index) => (
            <TypeValue key={index} context={context} value={type} />
          ))}
          separator=" | "
        />
      </Muted>
    );
  }
  if (isObjectSchemaField(field)) {
    return (
      <div className="flex flex-col text-left">
        <NestedObject context={context} members={field.members} />
        {field.nullable && <Muted>| null</Muted>}
      </div>
    );
  }
  return (
    <TypeText leavesByName={context.leavesByName} segments={context.model.typeTextSegments[field.type]} />
  );
};

const FieldRow = ({
  context,
  field,
  handle = false,
  nested = false,
}: {
  context: FieldContext;
  field: SchemaField;
  handle?: boolean;
  nested?: boolean;
}) => {
  const cells = nested ? MODEL_NODE_CLASSES.nested : MODEL_NODE_CLASSES.field;
  const portId = `${context.model.id}-source-${field.name}`;
  // a signature without a name, such as the row of a `ƒ` node, fills the whole row
  const fillsRow = isFunctionSchemaField(field) && field.name === "";
  const sourceHandle = handle && (
    <Handle id={portId} position={Position.Right} type="source">
      <SourcePort portId={portId} />
    </Handle>
  );
  return (
    <tr className={MODEL_NODE_CLASSES.field.root} data-inherited={field.inherited}>
      {fillsRow ? (
        <td className={classNames(cells.typeCell, "pl-2 text-left")} colSpan={2}>
          <FieldType context={context} field={field} />
          {sourceHandle}
        </td>
      ) : (
        <>
          <td className={cells.keyCell}>
            <FieldKey field={field} />
          </td>
          <td align="right" className={cells.typeCell}>
            <FieldType context={context} field={field} />
            {sourceHandle}
          </td>
        </>
      )}
    </tr>
  );
};

const ModelNodeContent = ({ id, data }: ModelNodeProps) => {
  const { model, badgeHubIds, collapsedLeafIds } = data;
  const decoration = useNodeDecoration(model);
  const leavesByName = useMemo(
    () =>
      new Map(
        model.dependencies
          .filter((dependency) => collapsedLeafIds.has(dependency.id))
          .map((dependency) => [dependency.name, dependency])
      ),
    [collapsedLeafIds, model.dependencies]
  );

  const hasSourceHandle = useMemo(() => {
    if (model.type === "interface") {
      return model.extends.some(isModelReference) || (model.headerRefs?.length ?? 0) > 0;
    }
    if (model.type === "class") {
      return (
        isModelReference(model.extends) ||
        model.implements.some(isModelReference) ||
        (model.headerRefs?.length ?? 0) > 0
      );
    }
    if (model.type === "typeAlias") {
      return getTypeAliasHeaderDependencies(model).some((dependency) => !badgeHubIds.has(dependency.id));
    }
    return false;
  }, [badgeHubIds, model]);

  const hasTargetHandle = useMemo(
    () => model.dependants.some((dependant) => !badgeHubIds.has(dependant.id)),
    [badgeHubIds, model.dependants]
  );

  const fieldSourceHandleRows = useMemo(() => {
    const rows = new Map<string, number>();
    for (const field of model.schema) {
      if (fieldHasSourceEdge(field, badgeHubIds)) rows.set(field.name, -1);
    }
    model.schema.forEach((field, index) => {
      if (rows.get(field.name) === -1) rows.set(field.name, index);
    });
    return rows;
  }, [badgeHubIds, model.schema]);

  const renderedHandleKey = useMemo(() => {
    const keys = [hasTargetHandle ? "target" : "", hasSourceHandle ? "source" : ""];
    return JSON.stringify([keys, [...fieldSourceHandleRows]]);
  }, [fieldSourceHandleRows, hasSourceHandle, hasTargetHandle]);
  const updateNodeInternals = useUpdateNodeInternals();
  const mountedHandleKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (mountedHandleKeyRef.current !== null && mountedHandleKeyRef.current !== renderedHandleKey) {
      updateNodeInternals(id);
    }
    mountedHandleKeyRef.current = renderedHandleKey;
  }, [id, renderedHandleKey, updateNodeInternals]);

  const headerClasses = useMemo(() => {
    const selected = decoration === "selected";
    const highlighted = decoration === "highlighted";
    const isHot = selected || highlighted;
    return {
      root: classNames(
        MODEL_NODE_CLASSES.root,
        selected ? "bg-node-selected" : "bg-pane",
        isHot ? "border-accent" : "border-border",
        decoration === "dimmed" && "opacity-50"
      ),
      header: classNames(
        "relative -mx-px -mt-px rounded-t-lg px-2 py-1 text-title font-strong text-brand-fg",
        selected ? "bg-brand-strong" : "bg-brand",
        model.schema.length === 0 ? "-mb-px rounded-b-lg" : "svg-export-header"
      ),
      fieldsWrapper: "model-node-fields flex flex-col",
    };
  }, [decoration, model.schema.length]);

  const fieldRows = useMemo(() => {
    const context = { model, badgeHubIds, collapsedLeafIds, leavesByName };
    return model.schema.map((field, fieldIndex) => (
      <FieldRow
        key={`${model.id}-${field.name}-${fieldIndex}`}
        context={context}
        field={field}
        handle={fieldSourceHandleRows.get(field.name) === fieldIndex}
      />
    ));
  }, [badgeHubIds, collapsedLeafIds, fieldSourceHandleRows, leavesByName, model]);

  const modelName = useMemo(() => {
    const nameParts = [model.name];

    if (model.type === "class" && model.isAbstract) {
      nameParts.unshift("abstract ");
    }

    if (model.type === "function") {
      nameParts.unshift("\u0192 ");
    }

    if (model.arguments.length > 0) {
      const argumentsParts = [];
      for (const argument of model.arguments) {
        let argumentStr = argument.name;
        if (argument.extends) {
          argumentStr += ` extends ${argument.extends}`;
        }
        if (argument.default) {
          argumentStr += ` = ${argument.default}`;
        }
        argumentsParts.push(argumentStr);
      }
      nameParts.push(`<${argumentsParts.join(", ")}>`);
    }

    if (model.type === "interface" && model.extends.length > 0) {
      const extendParts = [];
      for (const extendedItem of model.extends) {
        extendParts.push(isModelReference(extendedItem) ? extendedItem.name : extendedItem);
      }
      nameParts.push(` extends ${extendParts.join(", ")}`);
    }

    if (model.type === "class" && model.extends) {
      nameParts.push(` extends ${isModelReference(model.extends) ? model.extends.name : model.extends}`);
    }

    if (model.type === "class" && model.implements.length > 0) {
      const implementParts = [];
      for (const implementedItem of model.implements) {
        implementParts.push(isModelReference(implementedItem) ? implementedItem.name : implementedItem);
      }
      nameParts.push(` implements ${implementParts.join(", ")}`);
    }

    return nameParts.join("");
  }, [model]);

  return (
    <div key={id} className={headerClasses.root}>
      <div className={headerClasses.header}>
        {hasTargetHandle && (
          <Handle id={`${model.id}-target`} position={Position.Left} type="target">
            <TargetPort portId={`${model.id}-target`} />
          </Handle>
        )}
        {modelName}
        {hasSourceHandle && (
          <Handle id={`${model.id}-source`} position={Position.Right} type="source">
            <SourcePort portId={`${model.id}-source`} />
          </Handle>
        )}
      </div>
      {model.schema.length > 0 && (
        <div className={headerClasses.fieldsWrapper}>
          <table>
            <tbody>{fieldRows}</tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export const ModelNode = memo(
  ModelNodeContent,
  (previous, next) => previous.id === next.id && previous.data === next.data
);
ModelNode.displayName = "ModelNode";
