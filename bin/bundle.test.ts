import { expect, it } from "vitest";
import { bundleSources, stripImports } from "./bundle.mjs";

it("drops the import statements in all 3 forms and keeps the declarations", () => {
  const source = [
    'import { A } from "./a";',
    'import type { B, C } from "./b";',
    "import {",
    "  D,",
    "  E,",
    '} from "./d";',
    'import * as ns from "./ns";',
    'import def, { F } from "./f";',
    'import "./side-effect";',
    "export type X = A & B;",
    "export interface Y { d: D }",
  ].join("\n");
  expect(stripImports(source)).toBe("export type X = A & B;\nexport interface Y { d: D }");
});

it("drops the re-exports and keeps the local exports", () => {
  const source = [
    'export * from "./a";',
    'export * as ns from "./b";',
    'export { C, D } from "./c";',
    'export type { E } from "./e";',
    "export {",
    "  F,",
    '} from "./f";',
    "export type G = string;",
    "export { G as H };",
  ].join("\n");
  expect(stripImports(source)).toBe("export type G = string;\nexport { G as H };");
});

it("wraps each file in a region named after the file", () => {
  const bundle = bundleSources([
    { name: "ids.ts", source: 'export type Id = string;\nimport { x } from "./x";' },
    { name: "plan.ts", source: 'import type { Id } from "./ids";\n\nexport interface Plan { id: Id }\n' },
  ]);
  expect(bundle).toBe(
    [
      "// #region ids.ts",
      "export type Id = string;",
      "// #endregion",
      "",
      "// #region plan.ts",
      "export interface Plan { id: Id }",
      "// #endregion",
    ].join("\n")
  );
});

it("skips an index that holds only re-exports", () => {
  const bundle = bundleSources([
    { name: "index.ts", source: '/** The public API. */\nexport * from "./a";\nexport { B } from "./b";\n' },
    { name: "a.ts", source: "export type A = 1;" },
  ]);
  expect(bundle).toBe("// #region a.ts\nexport type A = 1;\n// #endregion");
});

it("drops the inner section markers of a file and adds a note", () => {
  const bundle = bundleSources([
    {
      name: "core.ts",
      source: [
        "// #region Ids",
        "export type Id = string;",
        "// #endregion",
        "// ---",
        "// 2. Plans",
        "// ---",
        "export type Plan = { id: Id };",
      ].join("\n"),
    },
  ]);
  expect(bundle).toBe(
    [
      "// #region core.ts",
      "// Note: 4 inner section marker(s) dropped. The parser does not nest sections.",
      "export type Id = string;",
      "// 2. Plans",
      "export type Plan = { id: Id };",
      "// #endregion",
    ].join("\n")
  );
});
