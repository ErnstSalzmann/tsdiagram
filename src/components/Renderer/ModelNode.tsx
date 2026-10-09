import { Fragment, memo, ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import classNames from "classnames";
import {
  InlineObjectMember,
  isArraySchemaField,
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
import { fieldHasSourceEdge, getTypeAliasHeaderDependencies } from "./layout";
import { usePortColor } from "./port-colors";

export type ModelNodeProps = {
  id: string;
  data: { model: Model; badgeHubIds: ReadonlySet<string> };
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
  /** The box of an inline object: the look of the rows of the node, with a thin border and less padding. */
  nested: {
    root: "my-0.5 border border-border",
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

const TypeNameSpan = ({ badgeHubIds, refModel }: { badgeHubIds: ReadonlySet<string>; refModel: Model }) => {
  if (badgeHubIds.has(refModel.id)) return <HubBadgePill key={refModel.id} refModel={refModel} />;
  return <span className={MODEL_NODE_CLASSES.field.modelTypeColor}>{refModel.name}</span>;
};

const TYPE_TEXT_COLORS = {
  primitive: MODEL_NODE_CLASSES.field.primitiveTypeColor,
  literal: MODEL_NODE_CLASSES.field.literalTypeColor,
  reference: MODEL_NODE_CLASSES.field.modelTypeColor,
};

const TypeText = ({ segments }: { segments: TypeTextSegment[] }) => (
  <span className={MODEL_NODE_CLASSES.field.defaultTypeColor}>
    {segments.map((segment, index) => {
      if (segment.kind === "default") return segment.text;
      return (
        <span key={index} className={TYPE_TEXT_COLORS[segment.kind]}>
          {segment.text}
        </span>
      );
    })}
  </span>
);

type FieldContext = { model: Model; badgeHubIds: ReadonlySet<string> };

const Muted = ({ children }: { children: ReactNode }) => (
  <span className={MODEL_NODE_CLASSES.field.defaultTypeColor}>{children}</span>
);

/** A model reference as a name or a pill, or a type text with colored segments. */
const TypeValue = ({ context, value }: { context: FieldContext; value: Model | string }) => {
  if (isModelReference(value)) return <TypeNameSpan badgeHubIds={context.badgeHubIds} refModel={value} />;
  return <TypeText segments={context.model.typeTextSegments[value]} />;
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

const FieldKey = ({ context, field }: { context: FieldContext; field: SchemaField }) => (
  <>
    {field.modifiers && field.modifiers.length > 0 && <Muted>{`${field.modifiers.join(" ")} `}</Muted>}
    {isFunctionSchemaField(field) && field.accessor && <Muted>{field.accessor} </Muted>}
    <span className={field.inherited ? MODEL_NODE_CLASSES.field.inheritedName : undefined}>{field.name}</span>
    {field.optional && <Muted>?</Muted>}
    {isFunctionSchemaField(field) && (
      <>
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
      </>
    )}
  </>
);

const NestedObject = ({ context, members }: { context: FieldContext; members: SchemaField[] }) => (
  <div className={MODEL_NODE_CLASSES.nested.root}>
    <table className="w-full">
      <tbody>
        {members.map((member, index) => (
          <FieldRow key={`${member.name}-${index}`} context={context} field={member} nested />
        ))}
      </tbody>
    </table>
  </div>
);

/** Inline objects stack as boxes. The other members follow as 1 line of text. */
const UnionWithObjects = ({ context, field }: { context: FieldContext; field: UnionSchemaField }) => {
  const objects = field.types.filter(isInlineObjectMember);
  const others = field.types.filter(isTextOrModel);
  return (
    <div className="flex flex-col text-left">
      {objects.map((object, index) => (
        <Fragment key={index}>
          {index > 0 && <Muted>|</Muted>}
          <NestedObject context={context} members={object.members} />
        </Fragment>
      ))}
      {others.length > 0 && (
        <Muted>
          {"| "}
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
  const isReadonlyArray =
    (isArraySchemaField(field) && field.readonly) ||
    (isFunctionSchemaField(field) && field.returnTypeReadonly);
  const readonlyPrefix = isReadonlyArray && <Muted>readonly </Muted>;

  if (isModelReference(field.type)) {
    return <TypeNameSpan badgeHubIds={context.badgeHubIds} refModel={field.type} />;
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
        <TypeText segments={context.model.typeTextSegments[field.genericName]} />
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
  if (isFunctionSchemaField(field)) {
    if (Array.isArray(field.returnType)) {
      return (
        <Muted>
          {readonlyPrefix}
          <TypeValue context={context} value={field.returnType[0]} />
          []
        </Muted>
      );
    }
    return <TypeValue context={context} value={field.returnType} />;
  }
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
  return <TypeText segments={context.model.typeTextSegments[field.type]} />;
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
  return (
    <tr className={MODEL_NODE_CLASSES.field.root} data-inherited={field.inherited}>
      <td className={cells.keyCell}>
        <FieldKey context={context} field={field} />
      </td>
      <td align="right" className={cells.typeCell}>
        <FieldType context={context} field={field} />
        {handle && (
          <Handle id={portId} position={Position.Right} type="source">
            <SourcePort portId={portId} />
          </Handle>
        )}
      </td>
    </tr>
  );
};

const ModelNodeContent = ({ id, data }: ModelNodeProps) => {
  const { model, badgeHubIds } = data;
  const decoration = useNodeDecoration(model);

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

  const hasTargetHandle = useMemo(() => model.dependants.length > 0, [model.dependants]);

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
    const context = { model, badgeHubIds };
    return model.schema.map((field, fieldIndex) => (
      <FieldRow
        key={`${model.id}-${field.name}-${fieldIndex}`}
        context={context}
        field={field}
        handle={fieldSourceHandleRows.get(field.name) === fieldIndex}
      />
    ));
  }, [badgeHubIds, fieldSourceHandleRows, model]);

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
