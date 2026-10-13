import type { Extent, Quantity } from "@mark1russell7/quantity";
import { compare, convertible } from "@mark1russell7/quantity";

/**
 * This type tells if an operation can go again after a failure. It is a property of the
 * operation, not of the dependency. One Redis client sends a GET, which is safe to send again. It
 * also sends an INCR, which counts two times when it goes again after a timeout. Each operation
 * declares its idempotency:
 * - `true`: a second issue has the same effect. Examples are an HTTP GET or PUT, a SELECT, a
 *   Redis GET or SET, and a write that the server removes when it is a copy.
 * - `false`: the client does not send it again after it can have reached the server.
 * - keyed: the server keeps a key for a window, as with an `Idempotency-Key` header, and it
 *   ignores a copy in that window. A copy after the window is a second operation. Thus the
 *   window is a timer, and it must be longer than all retries of the operation.
 */
export type Idempotency = boolean | { readonly key: string; readonly window: Extent };

/** An operation is an endpoint that the service calls or serves, a command, or a query. */
export interface Operation {
  readonly idempotent: Idempotency;
}

/**
 * This function tells if an operation can go again `since` its first issue. An idempotent
 * operation can always go again, and other operations cannot. A keyed operation can go again
 * while the server keeps its key.
 */
export const mayReissue = (operation: Operation, since: Quantity): boolean => {
  const { idempotent } = operation;
  if (typeof idempotent === "boolean") return idempotent;
  return compare(since, idempotent.window) < 0;
};

/** This function gives the problems in the declaration of an operation that `describe()` refuses. */
export const operationProblems = (owner: string, name: string, operation: Operation): string[] => {
  const { idempotent } = operation;
  if (typeof idempotent === "boolean") return [];
  const problems: string[] = [];
  if (idempotent.key.trim().length === 0) problems.push(`${owner}'s ${name} names no key`);
  if (!convertible(idempotent.window.unit, "s"))
    problems.push(`${owner}'s ${name} holds its key for a span that is not a time`);
  return problems;
};
