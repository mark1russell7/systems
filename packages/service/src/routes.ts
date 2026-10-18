import type { Operation } from "./operation.ts";
import { operationProblems } from "./operation.ts";

/**
 * A route pattern matches the routes of a controller that its exact routes do not name. A
 * registry that changes while the service operates, for example a registry of procedures, thus
 * needs no list of routes before the start. The syntax of a pattern:
 * - `*` matches each text, also an empty text and a text with `/`. The pattern `*` alone matches
 *   each route.
 * - `:name` matches a text of one character or more without `/`, and gives it in `params.name`.
 * - Each other character matches itself.
 *
 * The declaration names the operations that a request of the pattern can be. Each operation
 * declares its idempotency, as a route does. A function picks the operation of each request.
 */
export interface RoutePattern {
  readonly pattern: string;
  /** These are the operations that a request of the pattern can be, by name. */
  readonly operations: Readonly<Record<string, Operation>>;
}

/** A route request is what the function of a pattern gets for one request. */
export interface RouteRequest {
  readonly controller: string;
  readonly route: string;
  /** These are the texts of the `:name` parts of the pattern, by name. */
  readonly params: Readonly<Record<string, string>>;
  /** These are the texts of the `*` parts of the pattern, in their sequence. */
  readonly wildcards: readonly string[];
  /** This value is the detail that the transport gives with the request, or undefined. */
  readonly detail: unknown;
}

/**
 * An operation choice gives the name of the operation of one request: one of the operations that
 * the pattern declares. Thus the function decides the idempotency of each request, and the
 * declaration keeps each window of a keyed operation as data.
 */
export type OperationOf = (request: RouteRequest) => string;

/** A compiled pattern matches a route, and gives the parts of the route that it matched. */
export interface CompiledPattern {
  readonly pattern: string;
  match(route: string): { readonly params: Record<string, string>; readonly wildcards: string[] } | null;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** This function gives the problems of the syntax of a pattern: an empty pattern, a part without a name, or a name two times. */
export const patternProblems = (owner: string, pattern: string): string[] => {
  const problems: string[] = [];
  if (pattern.length === 0) problems.push(`${owner} has an empty route pattern`);
  const names = new Set<string>();
  for (let at = 0; at < pattern.length; at += 1) {
    if (pattern[at] !== ":") continue;
    const name = NAME.exec(pattern.slice(at + 1))?.[0];
    if (name === undefined) {
      problems.push(`${owner}'s pattern ${pattern} has a ":" without a name at ${at}`);
      continue;
    }
    if (names.has(name)) problems.push(`${owner}'s pattern ${pattern} names :${name} two times`);
    names.add(name);
    at += name.length;
  }
  return problems;
};

/** This function gives the problems of a pattern and of each of its operations, which `describe()` refuses. */
export const routePatternProblems = (owner: string, declared: RoutePattern): string[] => {
  const problems = patternProblems(owner, declared.pattern);
  const names = Object.keys(declared.operations);
  if (names.length === 0) problems.push(`${owner}'s pattern ${declared.pattern} declares no operation`);
  for (const name of names)
    problems.push(...operationProblems(owner, `${declared.pattern} (${name})`, declared.operations[name]!));
  return problems;
};

/** This function compiles a pattern to a matcher. The match must cover the whole route. */
export const compilePattern = (pattern: string): CompiledPattern => {
  const kinds: Array<{ kind: "param"; name: string } | { kind: "wildcard" }> = [];
  let source = "^";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char === "*") {
      source += "([\\s\\S]*)";
      kinds.push({ kind: "wildcard" });
      continue;
    }
    if (char === ":") {
      const name = NAME.exec(pattern.slice(at + 1))?.[0];
      if (name !== undefined) {
        source += "([^/]+)";
        kinds.push({ kind: "param", name });
        at += name.length;
        continue;
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  const matcher = new RegExp(`${source}$`);
  return {
    pattern,
    match(route) {
      const found = matcher.exec(route);
      if (found === null) return null;
      const params: Record<string, string> = {};
      const wildcards: string[] = [];
      kinds.forEach((part, index) => {
        const text = found[index + 1] ?? "";
        if (part.kind === "param") params[part.name] = text;
        else wildcards.push(text);
      });
      return { params, wildcards };
    },
  };
};
