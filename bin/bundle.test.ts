import { describe, expect, it } from "vitest";
import { bundleSources, resolveNames, stripImports } from "./bundle.mjs";

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

describe("names across files", () => {
  const files = [
    {
      name: "domain.ts",
      path: "/m/core/domain.ts",
      source:
        'export type Failure = { kind: "outsideFirstSlice" };\nexport type Plan = { failure: Failure };\n',
    },
    {
      name: "outcome.ts",
      path: "/m/core/outcome.ts",
      source:
        'import type { Plan } from "./domain.js";\nexport type Failure = { kind: "writeRejected"; note: "Failure" };\nexport type Outcome = { plan: Plan; failure: Failure };\n',
    },
    {
      name: "run.ts",
      path: "/m/workflow/run.ts",
      source:
        'import type { Failure as OperationFailure, Outcome } from "../core/outcome.js";\nexport type Report = { failure: OperationFailure; outcome: Outcome };\n',
    },
  ];

  it("puts the file name in front of a name that 2 files declare", () => {
    const [domain, outcome] = resolveNames(files);
    expect(domain.source).toContain("export type DomainFailure =");
    expect(domain.source).toContain("failure: DomainFailure");
    expect(outcome.source).toContain("export type OutcomeFailure =");
    expect(outcome.source).toContain("failure: OutcomeFailure");
  });

  it("keeps strings, property keys, and unique names", () => {
    const [, outcome] = resolveNames(files);
    expect(outcome.source).toContain('note: "Failure"');
    expect(outcome.source).toContain("failure: OutcomeFailure");
    expect(outcome.source).toContain("plan: Plan;");
  });

  it("replaces an import alias with the name of its declaration", () => {
    const [, , run] = resolveNames(files);
    expect(run.source).toContain("failure: OutcomeFailure;");
    expect(run.source).not.toContain("failure: OperationFailure");
  });

  it("names functions in camel case", () => {
    const [a] = resolveNames([
      { name: "pilotReader.ts", source: "function diff(a: number) { return a; }\n" },
      { name: "loggedDecisions.ts", source: "function diff(b: number) { return b; }\n" },
    ]);
    expect(a.source).toContain("function pilotReaderDiff(");
  });
});
