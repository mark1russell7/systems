import { describe, expect, it } from "vitest";
import { PG_RTT_MS, PG_TARGET } from "./t01.ts";
import { STATEMENT_DEADLINE, pgTargetWith, serverValues, statementDeadline } from "./server.ts";

describe("the settings of the PostgreSQL server", () => {
  it("puts each setting of a cell on the command line of the server, in the unit of its knob", () => {
    const target = pgTargetWith(PG_TARGET, { statement_timeout: 10000, lock_timeout: 2000 });
    expect(target.command?.[2]).toBe(
      "POSTGRES_HOST_AUTH_METHOD=trust docker-entrypoint.sh postgres -c statement_timeout=10000 -c lock_timeout=2000 & echo $! > /tmp/server.pid; while :; do sleep 3600; done",
    );
    expect({ ...target, command: undefined }).toEqual({ ...PG_TARGET, command: undefined });
  });

  it("refuses a setting that is not a knob of the session", () => {
    expect(() => serverValues({ statement_timeout_ms: 10 })).toThrow(/no knob/);
  });

  it("gives the statement deadline as the client sees it: the timer, its lateness, a round trip and the slack of the client", () => {
    const deadline = statementDeadline({ statement_timeout: STATEMENT_DEADLINE * 1000 }, PG_RTT_MS, 0.01);
    expect(deadline?.errno).toBe("57014");
    expect(deadline?.band.lo).toBe(STATEMENT_DEADLINE);
    // the alarm slack of 10 ms, the round trip of 2 ms and the slack of 10 ms
    expect(deadline?.band.hi).toBeCloseTo(STATEMENT_DEADLINE + 0.022, 9);
    // at the default, statement_timeout is off
    expect(statementDeadline({}, PG_RTT_MS, 0.01)).toBeNull();
  });
});
