import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDENTITY_TYPES } from "./identity.ts";

// The test calculates the list of `identity.ts` from the sources. TypeScript 7 has no compiler API
// in JavaScript, thus the test reads the declarations as text: comments and the contents of strings
// become spaces, and each declaration ends at its closing brace or at its semicolon.

const SRC = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(SRC, "..");

/** The maps of each module that keep state by identity. A new map adds its key or its writer to `ROOTS`. */
const IDENTITY_MAPS: Readonly<Record<string, number>> = { "drains.ts": 3, "http/answers.ts": 1 };

/**
 * The roots. `Lifecycle` keys the late holds and the outside counts, and `RequestStream` keys the
 * owners. The values of `TransportImpl` and `RequestHandler` write the holds and the marks of their copy.
 */
const ROOTS = ["lifecycle.ts#Lifecycle", "lifecycle.ts#TransportImpl", "requests.ts#RequestStream", "http/transport.ts#RequestHandler"];

/** This function gives each source file of the package that is not a test, as a path from `src/`. */
const sources = (folder = SRC): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [relative(SRC, path).split("\\").join("/")];
  });

/** This function gives the text with comments, and the contents of strings, as spaces. The length stays. */
const blank = (text: string): string => {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      out += " ".repeat(stop - index);
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2) + 2;
      out += text.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
      out += char + text.slice(index + 1, end).replace(/[^\n]/g, " ") + char;
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
};

interface Module {
  readonly blanked: string;
  /** The local name of each import of a type, to the module and its name there. */
  readonly imports: ReadonlyMap<string, readonly [string, string]>;
  /** The name of each re-export of a type, to the module and its name there. */
  readonly reexports: ReadonlyMap<string, readonly [string, string]>;
  /** The text of each declaration of a type, by its name. */
  readonly declarations: ReadonlyMap<string, { readonly exported: boolean; readonly body: string }>;
}

/** This function gives the pairs of a list of names in braces: `A`, `type A` and `A as B` give [local, given]. */
const namesOf = (list: string): Array<readonly [string, string]> =>
  list
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0)
    .map((part) => {
      const [given, local] = part.split(/\s+as\s+/);
      return [local ?? given!, given!] as const;
    });

/** This function gives the end of the declaration that starts at `start`: its closing brace, or a semicolon outside each bracket. */
const endOf = (text: string, start: number, braced: boolean): number => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (braced && depth === 0 && char === "}") return index + 1;
    }
    if (!braced && depth === 0 && char === ";") return index + 1;
    // a type alias with no semicolon ends at the next declaration of the module
    if (!braced && depth === 0 && /\n(export |const |function |interface |type |class )/y.test(text.slice(index, index + 12))) return index;
  }
  return text.length;
};

const modules = new Map<string, Module>();
for (const file of sources()) {
  const raw = readFileSync(join(SRC, file), "utf8");
  const blanked = blank(raw);
  const local = (specifier: string): string => posix.normalize(posix.join(posix.dirname(file), specifier));
  const imports = new Map<string, readonly [string, string]>();
  for (const match of raw.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]+)"/gm)) {
    for (const [name, given] of namesOf(match[2]!)) imports.set(name, [local(match[3]!), given]);
  }
  const reexports = new Map<string, readonly [string, string]>();
  for (const match of raw.matchAll(/^export\s+(type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]+)"/gm)) {
    for (const [name, given] of namesOf(match[2]!)) reexports.set(name, [local(match[3]!), given]);
  }
  const declarations = new Map<string, { exported: boolean; body: string }>();
  for (const match of blanked.matchAll(/^(export\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|class)\s+(\w+)/gm)) {
    const end = endOf(blanked, match.index + match[0].length, match[2] !== "type");
    declarations.set(match[3]!, { exported: match[1] !== undefined, body: blanked.slice(match.index + match[0].length, end) });
  }
  modules.set(file, { blanked, imports, reexports, declarations });
}

/** This function gives the declaration that a name of a module names, as `file#name`, or null for a name of another package. */
const resolve = (file: string, name: string, seen = new Set<string>()): string | null => {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const module = modules.get(file);
  if (module === undefined) return null;
  if (module.declarations.has(name)) return key;
  const link = module.imports.get(name) ?? module.reexports.get(name);
  return link === undefined ? null : resolve(link[0], link[1], seen);
};

/** Each declaration, with the declarations that its text names. */
const edges = new Map<string, Set<string>>();
for (const [file, module] of modules) {
  for (const [name, declaration] of module.declarations) {
    const named = new Set<string>();
    for (const word of declaration.body.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      const target = resolve(file, word[0]);
      if (target !== null && target !== `${file}#${name}`) named.add(target);
    }
    edges.set(`${file}#${name}`, named);
  }
}

/** The declarations that reach a root. */
const reaching = new Set(ROOTS);
for (let grew = true; grew; ) {
  grew = false;
  for (const [key, named] of edges) {
    if (!reaching.has(key) && [...named].some((target) => reaching.has(target))) {
      reaching.add(key);
      grew = true;
    }
  }
}

/** The entry points of the package, from the field `exports`, as paths from `src/`. */
const entries = (): string[] => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { exports: Record<string, string> };
  return Object.values(manifest.exports)
    .filter((path) => path.startsWith("./src/"))
    .map((path) => path.slice("./src/".length));
};

/** Each public name of a type, with the declaration that it names. */
const publicTypes = (): Array<readonly [string, string]> =>
  entries().flatMap((entry) => {
    const module = modules.get(entry)!;
    const named = [...module.reexports.keys()].map((name) => [name, resolve(entry, name)] as const);
    const declared = [...module.declarations].filter(([, declaration]) => declaration.exported).map(([name]) => [name, `${entry}#${name}`] as const);
    return [...named, ...declared].filter((pair): pair is readonly [string, string] => pair[1] !== null);
  });

describe("the types that service knows by identity", () => {
  it("finds each map of state by identity in the modules that the roots name", () => {
    const maps = Object.fromEntries(
      [...modules].map(([file, module]) => [file, (module.blanked.match(/new Weak(Map|Set|Ref)\b/g) ?? []).length] as const).filter(([, count]) => count > 0),
    );
    expect(maps).toEqual(IDENTITY_MAPS);
  });

  it("checks no class of service with instanceof, thus a value of another copy passes each check", () => {
    const classes = new Set([...modules.values()].flatMap((module) => [...module.blanked.matchAll(/^(?:export\s+)?class\s+(\w+)/gm)].map((match) => match[1]!)));
    const checks = [...modules.values()].flatMap((module) => [...module.blanked.matchAll(/\binstanceof\s+(\w+)/g)].map((match) => match[1]!));
    expect(checks.filter((name) => classes.has(name))).toEqual([]);
  });

  it("resolves each root to a declaration", () => {
    for (const root of ROOTS) expect(edges.has(root), root).toBe(true);
  });

  it("lists each exported type that reaches a root, and no other", () => {
    const pairs = publicTypes();
    const listed = [...new Set(pairs.filter(([, key]) => reaching.has(key)).map(([name]) => name))].sort();
    expect([...IDENTITY_TYPES].sort()).toEqual(listed);
    // one public name does not name a type that reaches a root and also a type that does not
    const ambiguous = pairs.filter(([name, key]) => listed.includes(name) && !reaching.has(key)).map(([name]) => name);
    expect(ambiguous).toEqual([]);
  });

  it("is exported from the main entry point", async () => {
    const main = await import("./index.ts");
    expect(main.IDENTITY_TYPES).toBe(IDENTITY_TYPES);
  });
});
