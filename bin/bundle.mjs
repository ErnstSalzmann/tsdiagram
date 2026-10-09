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

/** Removes the import statements and the re-exports of 1 file. */
export const stripImports = (source) => source.replace(IMPORT_PATTERN, "").replace(REEXPORT_PATTERN, "");

/**
 * Wraps each file in `// #region <name>` and `// #endregion`. A file that has
 * no declarations after the imports and the re-exports are removed, for
 * example an `index.ts` of re-exports, is skipped. Inner section markers are
 * dropped, with a note at the top of the region.
 */
export const bundleSources = (files) =>
  files
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
      files.map(async (file) => ({ name: file.name, source: await readFile(file.path, "utf8") }))
    )
  );
