import { describe, expect, it } from "vitest";
import { LINUX_66, budget, detection, granularity, keepalive, retransmission } from "./linux.ts";

const close = (value: number, to: number) => expect(value).toBeCloseTo(to, 6);
const scaled = { ...LINUX_66, keepidle: 5000, keepintvl: 2000, keepcnt: 3 };

describe("the closed forms agree with the algebra in jarvis", () => {
  it("gives the canonical figures of Linux 6.6 at HZ 250", () => {
    const ka = keepalive(LINUX_66);
    close(ka.duration, 7_875_000);
    // the research figure: a 2 h timer up to 131 s late, and keepalive up to 149.5 s
    close(ka.late, 149_504);
    close(ka.early, 4);
    close(budget(15), 924_600);
    close(retransmission(LINUX_66).late, 141_344);
  });

  it("gives the bounds of the scaled harness cells", () => {
    const ka = keepalive(scaled);
    close(ka.duration, 11_000);
    close(ka.late, 352);
    const r3 = retransmission({ ...scaled, retries: 3 });
    close(r3.duration, 3000);
    close(r3.late, 3616);
    // the firings fall at 0.408, 1.224 and 2.856 s, and the give-up comes at 6.12 s
    expect(r3.firings.map((t) => Math.round(t))).toEqual([408, 1224, 2856, 6120]);
    close(r3.giveUp, 6120);
    close(retransmission({ ...scaled, retries: 5, rtt: 20 }).late, 14_944);
  });

  it("files a timer on the level of the wheel that its length chooses", () => {
    expect([granularity(62), granularity(63), granularity(503), granularity(504)]).toEqual([1, 8, 8, 64]);
    expect(granularity(1_800_000)).toBe(32_768);
  });

  it("finds the first live detector for each situation", () => {
    expect(detection(scaled, "idle", true).timer).toBe("keepalive");
    expect(detection(scaled, "in-flight", true).timer).toBe("retransmission");
    expect(detection(scaled, "frozen", true).timer).toBeNull();
    expect(detection(scaled, "idle", false).timer).toBeNull();
  });
});
