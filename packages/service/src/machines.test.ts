import type { Machine } from "@mark1russell7/algebra";
import { algebraProblems, machineProblems, machineSchema, timerOf } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent, MachineName, Rule } from "./index.ts";
import { MACHINES, STAGES, capKnob, drainMachine, lint, replay, service } from "./index.ts";
import { CAPS, exited, rig, run } from "./rig.ts";
import { fakeClock, scriptedCheck, seeded } from "./testing.ts";

/**
 * E8: the machines of the runtime are documents. Each document is valid for the algebra. The
 * transitions that the runtime records replay against the documents. The timers of the documents,
 * which the algebra evaluates, give the times that the runtime keeps.
 */

const s = (value: number) => ({ value, unit: "s" });
const seconds = (amount: unknown): number => valueIn(amount as { value: number; unit: string }, "ms");

/** These scenarios move each machine through its states. Each one gives its events and its declaration. */
const scenarios = async (): Promise<Array<{ name: string; events: LifecycleEvent[]; drain: Machine }>> => {
  const out: Array<{ name: string; events: LifecycleEvent[]; drain: Machine }> = [];
  const keep = (name: string, events: LifecycleEvent[], r: ReturnType<typeof rig>) =>
    out.push({ name, events, drain: drainMachine(r.svc.describe()) });

  // a life: the startup, a failure of db and its recovery, a hung check, and the shutdown
  {
    const r = rig({ connect: { db: 200 } });
    const life = await run(r);
    r.checks.db.behavior = "error";
    await r.clock.advance(4000);
    r.checks.db.behavior = "ok";
    await r.clock.advance(2000);
    r.checks.cache.behavior = "hang";
    await r.clock.advance(3000);
    r.checks.cache.heal();
    r.checks.cache.behavior = "ok";
    await r.clock.advance(2000);
    r.checks.db.behavior = "timeout";
    await r.clock.advance(2000);
    r.checks.db.behavior = "ok";
    void life.request("api", "GET /things", () => new Promise<string>(() => {}));
    r.process.signal("SIGTERM");
    await r.clock.advance(500);
    r.process.signal("SIGINT");
    await exited(r, life);
    keep("a life with failures, a hung check and two signals", r.events, r);
  }
  // a startup that fails
  {
    const r = rig({ failConnect: "cache" });
    const life = await run(r);
    await exited(r, life);
    keep("a startup that fails", r.events, r);
  }
  // a signal during the startup, over the budget
  {
    const r = rig({ budget: 1, connect: { db: 2000 } });
    let sent = false;
    const life = await run(r, (at) => {
      if (at >= 500 && !sent) {
        sent = true;
        r.process.signal("SIGTERM");
      }
    });
    await exited(r, life);
    keep("a signal during the startup, over the budget", r.events, r);
  }
  // a phase that outlives its cap, and a work that throws
  {
    const r = rig();
    r.svc.onPhase("close transports", () => new Promise<void>(() => {}));
    r.svc.onPhase("drain", () => {
      throw new Error("no");
    });
    const life = await run(r);
    void life.shutdown();
    await exited(r, life);
    keep("a phase over its cap, and a work that throws", r.events, r);
  }
  // a blocked event loop
  {
    const r = rig({ watchdog: true });
    const life = await run(r);
    r.clock.block(3000);
    await r.clock.advance(300);
    r.clock.block(2000);
    await r.clock.advance(300);
    await r.clock.advance(2000);
    void life.shutdown();
    await exited(r, life);
    keep("a blocked event loop", r.events, r);
  }
  // a repeat signal that exits at once, during the drain
  {
    const r = rig();
    r.svc.onRepeatSignal("exit");
    const life = await run(r);
    void life.request("api", "GET /things", () => new Promise<string>(() => {}));
    r.process.signal("SIGTERM");
    await r.clock.advance(1500);
    r.process.signal("SIGINT");
    await exited(r, life);
    await r.clock.advance(10_000);
    keep("a repeat signal that exits at once", r.events, r);
  }
  // the flush of the output, and a cooperative abort at the start of the drain
  {
    const r = rig({ caps: { ...CAPS, "flush the output": 1 }, window: s(4), flush: 200 });
    r.svc.cooperativeFloor("none");
    const life = await run(r);
    void life.request("api", "GET /things", (signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))));
    void life.shutdown("the work ended", { code: 3 });
    await exited(r, life);
    keep("a flush of the output, and a cooperative abort at once", r.events, r);
  }
  // a window latch that recovers, through the health runtime alone
  {
    const events: LifecycleEvent[] = [];
    const clock = fakeClock();
    const check = scriptedCheck("ok");
    const svc = service("windowed")
      .check(
        {
          name: "self.state",
          dependency: null,
          step: "local-state",
          ownConnection: true,
          gates: "liveness",
          poll: { interval: s(1), jitter: 0, timeout: s(0.4) },
        },
        check.run,
      )
      .readiness({ type: "window", failAfter: s(0) })
      .liveness({ type: "window", failAfter: s(3), recoverAfter: s(2) })
      .startup(s(10))
      .phase("drain", s(1))
      .cooperativeWindow(s(0));
    const health = await svc.start({ clock, random: seeded(1), record: (event) => events.push(event) });
    await clock.advance(1500);
    check.behavior = "error";
    await clock.advance(1000);
    check.behavior = "ok";
    await clock.advance(1000);
    check.behavior = "error";
    await clock.advance(5000);
    check.behavior = "ok";
    await clock.advance(1000);
    check.behavior = "error";
    await clock.advance(1000);
    check.behavior = "ok";
    await clock.advance(4000);
    health.stop();
    out.push({ name: "a window that fails and recovers", events, drain: drainMachine(svc.describe()) });
  }
  return out;
};

describe("the machines of the runtime are documents (E8)", () => {
  const all = (drain: Machine): Array<[string, Machine]> => [...Object.entries(MACHINES), ["drain", drain]];
  const sample = drainMachine(rig().svc.describe());

  it.each(all(sample))("the %s document is valid, consistent, and the algebra reads each timer", (_name, doc) => {
    expect(machineSchema.safeParse(doc).success).toBe(true);
    expect(machineProblems(doc)).toEqual([]);
    expect(algebraProblems(doc)).toEqual([]);
  });

  it("replays each recorded transition of each machine against its document", async () => {
    const runs = await scenarios();
    const seen = new Map<string, Set<string>>();
    for (const { name, events, drain } of runs) {
      for (const [machine, doc] of all(drain)) {
        const mine = events.filter((event) => event.machine === (machine as MachineName));
        expect(replay(doc, mine), `${name}: ${machine}`).toEqual([]);
        const states = seen.get(machine) ?? new Set<string>();
        for (const event of mine) states.add(event.from).add(event.to);
        seen.set(machine, states);
      }
    }
    // the scenarios reach each state of each static document
    for (const [machine, doc] of Object.entries(MACHINES))
      expect([...(seen.get(machine) ?? [])].sort(), machine).toEqual(Object.keys(doc.states).sort());
    expect([...(seen.get("drain") ?? [])].sort()).toEqual(["done", "running", ...STAGES].sort());
  });

  it("refuses a trace that its document does not allow (the replay is not vacuous)", () => {
    const at = 0;
    const event = (from: string, to: string, on: string): LifecycleEvent => ({ at, machine: "exit", instance: "svc", from, to, on });
    expect(replay(MACHINES.exit, [event("running", "exited", "shutdown.done")])).toEqual([
      "svc: service.machine.exit has no transition from running on shutdown.done to exited",
    ]);
    expect(replay(MACHINES.exit, [event("running", "stopping", "exit.request"), event("running", "stopping", "exit.request")])).toEqual([
      "svc: the runtime left running on exit.request, but the replay is in stopping",
    ]);
  });
});

describe("the timers of the documents give the times of the runtime (the algebra)", () => {
  it("the startup budget, each phase's cap, and the drain's cooperative abort", async () => {
    const r = rig({ budget: 1, connect: { db: 2000 } });
    const life = await run(r);
    const over = r.events.find((event) => event.on === "startup.over-budget")!;
    const budget = timerOf(MACHINES.gate, "startup_budget", (name) => (name === "startup" ? s(1) : undefined)).duration;
    expect(over.at).toBe(seconds(budget));

    void life.request("api", "GET /things", () => new Promise<string>(() => {}));
    void life.shutdown();
    await exited(r, life);
    const doc = drainMachine(r.svc.describe());
    const values = (name: string) => {
      if (name === "cooperative_window") return s(1);
      const stage = STAGES.find((each) => capKnob(each) === name);
      return stage === undefined || !(stage in CAPS) ? undefined : s(CAPS[stage as keyof typeof CAPS]);
    };
    const moves = r.events.filter((event) => event.machine === "drain" && event.from !== event.to);
    for (let at = 1; at < moves.length; at += 1) {
      const phase = moves[at - 1]!.to;
      const cap = seconds(timerOf(doc, `${capKnob(phase)}_timer`, values).duration);
      expect(moves[at]!.at - moves[at - 1]!.at, phase).toBeLessThanOrEqual(cap);
    }
    // the readiness hold and the drain (a request outlives it) last their caps exactly
    const span = (phase: string) => {
      const at = moves.findIndex((move) => move.to === phase);
      return moves[at + 1]!.at - moves[at]!.at;
    };
    expect(span("fail readiness")).toBe(seconds(timerOf(doc, `${capKnob("fail readiness")}_timer`, values).duration));
    expect(span("drain")).toBe(seconds(timerOf(doc, `${capKnob("drain")}_timer`, values).duration));
    const abort = r.events.find((event) => event.on === "drain.cooperative-abort")!;
    const enter = moves.find((move) => move.to === "drain")!;
    expect(abort.at - enter.at).toBe(seconds(timerOf(doc, "cooperative_abort", values).duration));
  });

  it("the fail and recover windows of a window latch, and the timeout of a poll", async () => {
    const runs = await scenarios();
    const events = runs.find((each) => each.name === "a window that fails and recovers")!.events;
    const window = events.filter((event) => event.machine === "window");
    // each trip ends the failing episode that the latest move into `failing` started
    const tripped = window.find((event) => event.on === "window.failed")!;
    const failing = [...window].reverse().find((event) => event.to === "failing" && event.from !== "failing" && event.at <= tripped.at)!;
    const failAfter = timerOf(MACHINES.window, "fail_window", (name) => (name === "fail_after" ? s(3) : undefined)).duration;
    expect(tripped.at - failing.at).toBe(seconds(failAfter));
    const released = window.find((event) => event.on === "window.recovered")!;
    const recovering = [...window].reverse().find((event) => event.to === "recovering" && event.from !== "recovering" && event.at <= released.at)!;
    const recoverAfter = timerOf(MACHINES.window, "recover_window", (name) => (name === "recover_after" ? s(2) : undefined)).duration;
    expect(released.at - recovering.at).toBe(seconds(recoverAfter));

    const life = runs.find((each) => each.name === "a life with failures, a hung check and two signals")!.events;
    const polls = life.filter((event) => event.machine === "poller" && event.instance === "db.round-trip");
    const hung = polls.find((event) => event.on === "timeout")!;
    const call = [...polls].reverse().find((event) => event.to === "calling" && event.at <= hung.at)!;
    const timeout = timerOf(MACHINES.poller, "poll_timeout", (name) => (name === "timeout" ? s(0.4) : undefined)).duration;
    expect(hung.at - call.at).toBe(seconds(timeout));
  });

  it("the ordering law where the declaration binds the drain: O16, and the runtime's clamp", async () => {
    // O16: the cooperative window is shorter than the process's drain time (the declaration binds both)
    const O16: Rule = {
      id: "O16",
      rule: "the cooperative-cancel window is shorter than the process's drain deadline",
      expr: {
        lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
        op: "<",
        rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      },
    };
    const scenario = { platform: {}, probes: { readiness: s(10), liveness: s(30) } };
    for (const [window, verdict] of [
      [1, "holds"],
      [30, "violated"],
    ] as const) {
      const r = rig({ window: s(window) });
      const [finding] = lint(r.svc.describe(), scenario, [O16]);
      expect(finding?.verdict, `window ${window} s`).toBe(verdict);
      // where the law is violated the runtime clamps the abort to half the drain, and the algebra's
      // closed form of the drain's document gives the same clamp
      const doc = drainMachine(r.svc.describe());
      const abort = timerOf(doc, "cooperative_abort", (name) =>
        name === "drain_cap" ? s(CAPS.drain) : name === "cooperative_window" ? s(window) : undefined,
      ).duration;
      expect(seconds(abort), `window ${window} s`).toBe(Math.max(CAPS.drain - window, CAPS.drain / 2) * 1000);
    }
  });
});
