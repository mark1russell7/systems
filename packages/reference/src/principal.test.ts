// The principal of a scope has the shape of the principal of the client (SYS-134). The service package does not
// load the client, thus it keeps its own copy of the type. The reference service imports the two packages, and
// the typecheck of this file holds the two shapes equal: a change of one shape fails it.

import type { Principal as ScopePrincipal } from "@mark1russell7/service/scope";
import type { Principal as ClientPrincipal } from "@procedures/client";
import { describe, expectTypeOf, it } from "vitest";

describe("the principal of a scope", () => {
  it("has the shape of the principal of the client", () => {
    expectTypeOf<ScopePrincipal>().toEqualTypeOf<ClientPrincipal>();
  });
});
