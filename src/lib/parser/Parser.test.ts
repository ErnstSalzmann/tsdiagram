import { expect, it } from "vitest";
import { Parser } from "./Parser";

it("parses code into AST and updates it on code change", () => {
  const parser = new Parser("interface A { }");
  expect(parser.interfaces.length).toBe(1);

  parser.setSource("interface A { }; interface B { }");
  expect(parser.interfaces.length).toBe(2);
});

it("parses interfaces", () => {
  const parser = new Parser(`
    interface A { foo: string; bar(): string; }
    interface B { baz: A; }
    interface C extends A, B { qux: string; }
  `);

  const interfaces = parser.interfaces;
  expect(interfaces.length).toBe(3);

  const [A, B, C] = interfaces;

  expect(A.name).toBe("A");
  expect(A.declaration.getText()).toBe("interface A { foo: string; bar(): string; }");
  expect(A.extends.length).toBe(0);
  expect(A.properties.length).toBe(1);
  expect(A.properties[0].getName()).toBe("foo");
  expect(A.methods.length).toBe(1);
  expect(A.methods[0].getName()).toBe("bar");

  expect(B.name).toBe("B");
  expect(B.declaration.getText()).toBe("interface B { baz: A; }");
  expect(B.extends.length).toBe(0);
  expect(B.properties.length).toBe(1);
  expect(B.properties[0].getName()).toBe("baz");
  expect(B.methods.length).toBe(0);

  expect(C.name).toBe("C");
  expect(C.declaration.getText()).toBe("interface C extends A, B { qux: string; }");
  expect(C.extends.length).toBe(2);
  expect(C.extends[0].getText()).toBe("A");
  expect(C.extends[1].getText()).toBe("B");
  expect(C.properties.length).toBe(3);
  expect(C.properties[0].getName()).toBe("qux");
  expect(C.properties[1].getName()).toBe("foo");
  expect(C.properties[2].getName()).toBe("baz");
  expect(C.methods.length).toBe(1);
  expect(C.methods[0].getName()).toBe("bar");
});

it("parses type aliases", () => {
  const parser = new Parser(`
    type A = { foo: string; bar(): string; };
    type B = { baz: A; };
    type C = A & B;
    type D = string;
  `);

  const typeAliases = parser.typeAliases;
  expect(typeAliases.length).toBe(4);
  const [A, B, C, D] = typeAliases;

  expect(A.name).toBe("A");
  expect(A.declaration.getText()).toBe("type A = { foo: string; bar(): string; };");
  expect(A.type.getText()).toBe("A");

  expect(B.name).toBe("B");
  expect(B.declaration.getText()).toBe("type B = { baz: A; };");
  expect(B.type.getText()).toBe("B");

  expect(C.name).toBe("C");
  expect(C.declaration.getText()).toBe("type C = A & B;");
  expect(C.type.getText()).toBe("C");

  expect(D.name).toBe("D");
  expect(D.declaration.getText()).toBe("type D = string;");
  expect(D.type.getText()).toBe("string");
});

it("parses classes", () => {
  const parser = new Parser(`
    class A { foo: string; }
    class B { bar(): string { throw new Error(); } }
    class C extends A implements B { bar() { return "baz"; } }
  `);

  const classes = parser.classes;
  expect(classes.length).toBe(3);

  const [A, B, C] = classes;

  expect(A.name).toBe("A");
  expect(A.declaration.getText()).toBe("class A { foo: string; }");
  expect(A.extends).toBeUndefined();
  expect(A.properties.length).toBe(1);
  expect(A.properties[0].getName()).toBe("foo");
  expect(A.methods.length).toBe(0);

  expect(B.name).toBe("B");
  expect(B.declaration.getText()).toBe("class B { bar(): string { throw new Error(); } }");
  expect(B.extends).toBeUndefined();
  expect(B.properties.length).toBe(0);
  expect(B.methods.length).toBe(1);
  expect(B.methods[0].getName()).toBe("bar");

  expect(C.name).toBe("C");
  expect(C.declaration.getText()).toBe('class C extends A implements B { bar() { return "baz"; } }');
  expect(C.extends).toBeDefined();
  expect(C.extends?.getText()).toBe("A");
  expect(C.properties.length).toBe(1);
  expect(C.methods.length).toBe(1);
});

it("collects inherited getter and setter declarations separately from methods", () => {
  const parser = new Parser(`
    class Base {
      get value(): number { return 0; }
      set value(value: number) {}
    }
    class Child extends Base {}
    class Grandchild extends Child {}
  `);

  for (const item of parser.classes) {
    expect(item.getAccessors.map((accessor) => accessor.getName())).toEqual(["value"]);
    expect(item.setAccessors.map((accessor) => accessor.getName())).toEqual(["value"]);
    expect(item.properties).toEqual([]);
    expect(item.methods).toEqual([]);
  }
});

it("parses functions, groups overloads, and reads namespaces", () => {
  const parser = new Parser(`
    declare function a(x: string): void;
    function b(x: string): void;
    function b(x: number): void;
    function b(x: string | number): void {}
    namespace N { export function c(): void {} }
    export default function () {}
  `);

  const functions = parser.functions;
  expect(functions.map((f) => f.name)).toEqual(["a", "b", "N.c"]);
  expect(functions[1].signatures).toHaveLength(2);
  expect(functions[1].signatures.every((s) => !s.hasBody())).toBe(true);
  expect(functions[2].signatures).toHaveLength(1);
});

it("reads region sections and assigns each declaration to the header above it", () => {
  const parser = new Parser(`
    interface Loose {}
    // #region Models
    interface A {}
    type B = string;
    // #endregion
    enum C { One }
    // #region Ports
    class D {}
    namespace N { export function e(): void {} }
    declare function f(): void;
  `);

  expect(parser.sections).toEqual([
    { id: "section-0", title: "Models", order: 0 },
    { id: "section-1", title: "Ports", order: 1 },
  ]);
  expect(parser.interfaces.map((item) => item.section?.title)).toEqual([undefined, "Models"]);
  expect(parser.typeAliases[0].section?.id).toBe("section-0");
  expect(parser.enums[0].section).toBeUndefined();
  expect(parser.classes[0].section?.title).toBe("Ports");
  expect(parser.functions.map((item) => item.section?.title)).toEqual(["Ports", "Ports"]);
});

it("reads banner sections from a numbered title next to a dashed line", () => {
  const parser = new Parser(`
    // ---------------------------------------------------------------------------
    // 1. Identity
    // ---------------------------------------------------------------------------
    type Id = string;

    // 2. Result
    // -----
    type Result = { ok: boolean };

    // 3. Not a section: no dashed line
    type Plain = number;
  `);

  expect(parser.sections.map((section) => section.title)).toEqual(["1. Identity", "2. Result"]);
  expect(parser.typeAliases.map((item) => item.section?.order)).toEqual([0, 1, 1]);
});
