export type SchemaFieldModifier = "abstract" | "private" | "protected" | "readonly" | "static";
export type SharedSchemaField = {
  name: string;
  optional: boolean;
  inherited?: boolean;
  modifiers?: SchemaFieldModifier[];
  typeRefs?: Model[];
};
export type DefaultSchemaField = SharedSchemaField & { type: Model | string };
export type ArraySchemaField = SharedSchemaField & {
  type: "array";
  elementType: Model | string;
  readonly?: boolean;
};
export type GenericSchemaField = SharedSchemaField & {
  type: "generic";
  genericName: string;
  arguments: (Model | string)[];
};
export type FunctionSchemaField = SharedSchemaField & {
  type: "function";
  accessor?: "get" | "set";
  arguments: { name: string; type: Model | string }[];
  returnType: Model | [Model | string] | string;
  returnTypeReadonly?: boolean;
};
/** An object literal inside a union. It renders as a nested box. */
export type InlineObjectMember = { kind: "object"; members: SchemaField[] };
export type UnionSchemaField = SharedSchemaField & {
  type: "union";
  types: (InlineObjectMember | Model | string)[];
};
/** A field whose type is 1 object literal, with an optional `| null`. */
export type ObjectSchemaField = SharedSchemaField & {
  type: "object";
  members: SchemaField[];
  nullable: boolean;
};
export type SchemaField =
  | ArraySchemaField
  | DefaultSchemaField
  | FunctionSchemaField
  | GenericSchemaField
  | ObjectSchemaField
  | UnionSchemaField;

export const isArraySchemaField = (field: SchemaField): field is ArraySchemaField => {
  return field.type === "array";
};
export const isGenericSchemaField = (field: SchemaField): field is GenericSchemaField => {
  return field.type === "generic";
};
export const isFunctionSchemaField = (field: SchemaField): field is FunctionSchemaField => {
  return field.type === "function";
};
export const isUnionSchemaField = (field: SchemaField): field is UnionSchemaField => {
  return field.type === "union";
};
// the `members` check keeps a default field typed with the `object` keyword apart
export const isObjectSchemaField = (field: SchemaField): field is ObjectSchemaField => {
  return field.type === "object" && "members" in field;
};
export const isInlineObjectMember = (
  value: InlineObjectMember | Model | string | undefined
): value is InlineObjectMember => {
  return typeof value === "object" && value !== null && "members" in value;
};
export const isDefaultSchemaField = (field: SchemaField): field is DefaultSchemaField => {
  return (
    !isArraySchemaField(field) &&
    !isGenericSchemaField(field) &&
    !isFunctionSchemaField(field) &&
    !isUnionSchemaField(field) &&
    !isObjectSchemaField(field)
  );
};

const addModel = (models: Model[], value: InlineObjectMember | Model | string | undefined) => {
  if (typeof value !== "object" || value === undefined) return;
  if (isInlineObjectMember(value)) {
    for (const member of value.members) models.push(...getSchemaFieldModels(member));
  } else {
    models.push(value);
  }
};

/** Every model a field refers to, in its type, its type refs, and the members of its inline objects. */
export const getSchemaFieldModels = (field: SchemaField): Model[] => {
  const models: Model[] = [];
  if (isArraySchemaField(field)) addModel(models, field.elementType);
  else if (isGenericSchemaField(field)) field.arguments.forEach((argument) => addModel(models, argument));
  else if (isFunctionSchemaField(field)) {
    field.arguments.forEach((argument) => addModel(models, argument.type));
    addModel(models, Array.isArray(field.returnType) ? field.returnType[0] : field.returnType);
  } else if (isUnionSchemaField(field)) field.types.forEach((type) => addModel(models, type));
  else if (isObjectSchemaField(field))
    field.members.forEach((member) => models.push(...getSchemaFieldModels(member)));
  else addModel(models, field.type);
  for (const typeRef of field.typeRefs ?? []) models.push(typeRef);
  return models;
};

export type TypeTextSegment = {
  text: string;
  kind: "default" | "primitive" | "literal" | "reference";
};

export type ModelBase = {
  id: string;
  name: string;
  /** The section comment above the declaration, when there is one. */
  section?: { id: string; title: string; order: number };
  schema: SchemaField[];
  typeTextSegments: Record<string, TypeTextSegment[]>;
  dependencies: Model[];
  dependants: Model[];
  arguments: { name: string; extends?: string; default?: string }[];
};

export type InterfaceModel = ModelBase & {
  type: "interface";
  extends: (Model | ({} & string))[];
  headerRefs?: Model[];
};
export type TypeAliasModel = ModelBase & {
  type: "typeAlias";
};
export type ClassModel = ModelBase & {
  type: "class";
  extends?: Model | string;
  implements: (Model | ({} & string))[];
  isAbstract?: boolean;
  headerRefs?: Model[];
};
export type EnumModel = ModelBase & {
  type: "enum";
};
/** A top-level function. Each overload is 1 function row of the schema. */
export type FunctionModel = ModelBase & {
  type: "function";
};

export type Model = ClassModel | EnumModel | FunctionModel | InterfaceModel | TypeAliasModel;
