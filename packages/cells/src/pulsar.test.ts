import { PRODUCER_BACKOFF, planOf } from "@mark1russell7/kind";
import { describe, expect, it } from "vitest";
import { ms, s } from "./kind.ts";
import { PRODUCERS, PULSAR_CELLS, PULSAR_WORKLOAD, flipOf } from "./pulsar.ts";

describe("the S2 cell of Pulsar (SYS-56)", () => {
  it("has one cell in iptables: a crash stops the broker that owns the topic, with a producer on each worker", () => {
    expect(PULSAR_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.iptables.pulsar.broker-crash"]);
    const [cell] = PULSAR_CELLS;
    expect(cell!.name).toContain("Pulsar");
    expect(cell!.trigger).toEqual({ kind: "crash" });
    expect(cell!.pulsar).toEqual({ clients: 2, probe: ms(250) });
    expect(planOf(cell!).inject).toEqual([{ do: "signal", target: "broker", signal: "SIGKILL" }]);
    expect(PRODUCERS).toBe(2);
    // 30 s of sends is less than the 1000 pending messages of the client
    expect(30_000 / PULSAR_WORKLOAD.every.value).toBeLessThan(1000);
  });

  it("changes the owner 20.5–33 s after the crash: the session of 30 s, the ping after 9 s and the tick of 2 s", () => {
    expect(flipOf()).toEqual({ lo: s(20.5), hi: s(33) });
    expect(PULSAR_CELLS[0]!.prediction).toMatchObject({
      kind: "reconnects",
      flip: { lo: s(20.5), hi: s(33) },
      owner: "either",
      probe: s(1.25),
      disconnect: { lo: s(0), hi: s(1) },
      backoff: PRODUCER_BACKOFF,
      setup: { lo: s(0), hi: s(3) },
      outcomes: ["late", "timeout"],
    });
  });

  it("names the tries of the backoff in its reasons", () => {
    expect(PULSAR_CELLS[0]!.prediction.why).toMatch(/25\.5 s, 29\.9 s, 81\.1 s/);
  });
});
