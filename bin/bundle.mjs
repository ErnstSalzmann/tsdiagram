// Joins several TypeScript files into 1 source that the parser reads as 1
// document with 1 section per file.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// An `import` statement: default, namespace, named (also multi-line), `type`, or side-effect.
const IMPORT_PATTERN =
  /^[ \t]*import\s*(?:type\s+)?(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*(?:from\s*)?["'][^"']*["']\s*;?[ \t]*\r?\n?/gm;
// An `export ... from` re-export: `export * from`, `export * as x from`, `export { a } from`, `export type { a } from`.
const REEXPORT_PATTERN =
  /^[ \t]*export\s*(?:type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']*["']\s*;?[ \t]*\r?\n?/gm;
// The section markers that the parser reads: `// #region`, `// #endregion`, and the `// ---` banner rule.
// ponytail: the parser does not nest sections, so the file-level region replaces the inner markers.
const SECTION_MARKER_PATTERN = /^[ \t]*\/\/\s*(?:#region\b.*|#endregion\b.*|-{3,})[ \t]*\r?\n?/gm;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm;

// A top-level declaration at the start of a line: the name that other files import.
const DECLARATION_PATTERN =
  /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:type|interface|function\*?|class|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
// A named import with its module: `import { a, b as c, type d } from "./x.js"`.
const NAMED_IMPORT_PATTERN =
  /^[ \t]*import\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm;
// Strings and comments: their text is not code, so a rename must not touch it.
const NON_CODE_PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/;

const pascal = (text) => text.replace(/(^|[-_.\s]+)([a-zA-Z0-9])/g, (_, __, letter) => letter.toUpperCase());
const fileBase = (name) => path.basename(name).replace(/\.[cm]?tsx?$/, "");
const withoutExtension = (filePath) => filePath.replace(/\.[cm]?[jt]sx?$/, "");

/** The new name of a declaration that 2 files share: the file name in front, like `OutcomeFailure` or `pilotReaderDiff`. */
const qualifiedName = (file, name) => {
  const prefix = pascal(fileBase(file));
  return /^[A-Z]/.test(name)
    ? `${prefix}${name}`
    : `${prefix[0].toLowerCase()}${prefix.slice(1)}${pascal(name)}`;
};

const declaredNames = (source) => [...source.matchAll(DECLARATION_PATTERN)].map((match) => match[1]);

/** The named imports of 1 file as `{ local, imported, specifier }`. */
const namedImports = (source) =>
  [...source.matchAll(NAMED_IMPORT_PATTERN)].flatMap(([, list, specifier]) =>
    list
      .split(",")
      .map((entry) => entry.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((entry) => {
        const [imported, local = imported] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return { local, imported, specifier };
      })
  );

/** Renames identifiers in code. Strings, comments, property keys, and member accesses keep their text. */
const renameIdentifiers = (source, renames) => {
  if (renames.size === 0) return source;
  const names = [...renames.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/\$/g, "\\$"));
  const identifier = new RegExp(`(?<![\\w$.])(${names.join("|")})(?![\\w$])(?!\\s*\\??:(?!:))`, "g");
  return source
    .split(NON_CODE_PATTERN)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(identifier, (name) => renames.get(name) ?? name)
    )
    .join("");
};

/**
 * Gives every file of the bundle 1 shared scope. A name that 2 files declare
 * gets the file name in front, in its own file and in the files that import
 * it. An import alias, `import { Failure as OperationFailure }`, is replaced
 * by the name of the declaration it points at, because the imports are
 * dropped. Files are matched by `path` when it is given, else by name.
 */
export const resolveNames = (files) => {
  const keyOf = (file) => withoutExtension(file.path ?? file.name);
  const counts = new Map();
  for (const file of files)
    for (const name of new Set(declaredNames(file.source))) counts.set(name, (counts.get(name) ?? 0) + 1);
  const canonical = new Map(
    files.map((file) => [
      keyOf(file),
      new Map(
        declaredNames(file.source).map((name) => [
          name,
          counts.get(name) > 1 ? qualifiedName(file.name, name) : name,
        ])
      ),
    ])
  );
  return files.map((file) => {
    const renames = new Map();
    for (const [name, renamed] of canonical.get(keyOf(file)))
      if (name !== renamed) renames.set(name, renamed);
    for (const { local, imported, specifier } of namedImports(file.source)) {
      if (!specifier.startsWith(".")) continue;
      const base = file.path ? path.dirname(file.path) : ".";
      const target = canonical.get(withoutExtension(path.join(base, specifier)));
      const renamed = target?.get(imported);
      if (renamed && renamed !== local) renames.set(local, renamed);
    }
    return { ...file, source: renameIdentifiers(file.source, renames) };
  });
};

/** Removes the import statements and the re-exports of 1 file. */
export const stripImports = (source) => source.replace(IMPORT_PATTERN, "").replace(REEXPORT_PATTERN, "");

/**
 * Wraps each file in `// #region <name>` and `// #endregion`. A file that has
 * no declarations after the imports and the re-exports are removed, for
 * example an `index.ts` of re-exports, is skipped. Inner section markers are
 * dropped, with a note at the top of the region.
 */
export const bundleSources = (files) =>
  resolveNames(files)
    .map(({ name, source }) => {
      const stripped = stripImports(source);
      if (stripped.replace(COMMENT_PATTERN, "").trim() === "") return null;
      const markers = stripped.match(SECTION_MARKER_PATTERN)?.length ?? 0;
      const note = markers
        ? `// Note: ${markers} inner section marker(s) dropped. The parser does not nest sections.\n`
        : "";
      const body = stripped.replace(SECTION_MARKER_PATTERN, "").trim();
      return `// #region ${name}\n${note}${body}\n// #endregion`;
    })
    .filter(Boolean)
    .join("\n\n");

const isSourceFile = (name) => /\.ts$/.test(name) && !/\.(d|test|spec)\.ts$/.test(name);

/**
 * Lists the files of the inputs as `{ name, path }`. A folder gives its `.ts`
 * files that are not tests and not `.d.ts`, sorted by name. `name` is the file
 * name relative to its folder.
 */
export const discoverFiles = async (inputs) => {
  const files = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      const names = (await readdir(input)).filter(isSourceFile).sort();
      files.push(...names.map((name) => ({ name, path: path.join(input, name) })));
    } else {
      files.push({ name: path.basename(input), path: input });
    }
  }
  return files;
};

/** Reads and bundles the files of `discoverFiles`. */
export const readBundle = async (files) =>
  bundleSources(
    await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        path: file.path,
        source: await readFile(file.path, "utf8"),
      }))
    )
  );
