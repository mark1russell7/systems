import { timerOf } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "./events.ts";
import type { Lifecycle, Profile, RequestEnd, Rule, ServiceBuilder, TransportImpl } from "./index.ts";
import { DECLARATION_RULE, daemon, drainMachine, ephemeral, kubernetes, lint, localDev, service } from "./index.ts";
import { CAPS, exited, rig, run } from "./rig.ts";
import { fakeClock, fakeProcess, seeded } from "./testing.ts";

/**
 * The options of the runner: request tracking from the start of each transport (SYS-15), the policy
 * of a repeat signal (SYS-9), the profiles (SYS-10), the process triggers (SYS-7) and a process
 * that runs one command (SYS-16). Each test uses the fake clock and the fake process.
 */

const s = (value: number) => ({ value, unit: "s" });
const exitSteps = (events: readonly LifecycleEvent[]) =>
  events.filter((event) => event.machine === "exit").map((event) => `${event.from} -> ${event.to} on ${event.on}`);
const drainEnter = (events: readonly LifecycleEvent[], phase: string) =>
  events.find((event) => event.machine === "drain" && event.to === phase && event.from !== phase)!;

/** These rules are the drain rules of the law that a profile meets: O10 and O16, as kind gives them. */
const O10: Rule = {
  id: "O10",
  rule: "the preStop sleep plus the shutdown of the process fits in the grace period",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "process_drain_time", coef: 1, at: "process" },
      ],
    },
    op: "<=",
    rhs: { terms: [{ knob: "termination_grace", coef: 1, at: "pod" }] },
  },
};
const O16: Rule = {
  id: "O16",
  rule: "the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep",
  expr: {
    lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
    op: "<",
    rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
  },
  expr_more: [
    {
      lhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      op: "<",
      rhs: {
        terms: [
          { knob: "termination_grace", coef: 1, at: "pod" },
          { knob: "prestop_sleep", coef: -1, at: "pod" },
        ],
      },
    },
  ],
};
const podScenario = (grace: number, preStop: number) => ({
  platform: { "termination_grace@pod": s(grace), "prestop_sleep@pod": s(preStop) },
  probes: { readiness: s(30), liveness: s(30) },
});

/** This function starts a service on a fake clock and a fake process, and moves the clock until its startup ends. */
const runOn = async (svc: ServiceBuilder) => {
  const clock = fakeClock();
  const process = fakeProcess({ clock });
  const events: LifecycleEvent[] = [];
  let ended = false;
  const running = svc.run({ clock, random: seeded(1), process, record: (event) => events.push(event) }).finally(() => {
    ended = true;
  });
  for (let step = 0; step < 200 && !ended; step += 1) await clock.advance(50);
  const life = await running;
  const exit = async (): Promise<number> => {
    let code: number | null = null;
    void life.done.then((value) => {
      code = value;
    });
    for (let step = 0; step < 1200 && code === null; step += 1) await clock.advance(50);
    if (code === null) throw new Error("the lifecycle did not exit in 60 s of the fake clock");
    return code;
  };
  return { life, clock, process, events, exit };
};

describe("request tracking from the start of each transport (SYS-15)", () => {
  it("gives each transport the lifecycle at its start: a request in the warm-up gets a retryable refusal", async () => {
    const r = rig({ checkDelay: 300 });
    let given: Lifecycle | null = null;
    let fromBuilder: Lifecycle | null = null;
    let warmUp: Promise<{ readonly items: readonly string[]; readonly end: RequestEnd }> | null = null;
    const counts: Array<[number, boolean]> = [];
    r.svc.server("queue", {}, {
      start: (_signal, life) => {
        given = life;
        fromBuilder = r.svc.lifecycle;
        // the startup has not ended: the request, the count and keep-alive answer at once
        warmUp = life.request("api", "GET /things", () => "early").collect();
        counts.push([life.inFlight(), life.keepAlive()]);
      },
      stopIntake() {},
      drain() {},
      inFlight: () => 0,
      close() {},
    });
    expect(r.svc.lifecycle).toBeNull();
    const life = await run(r);
    expect(given).toBe(life);
    expect(fromBuilder).toBe(life);
    expect(r.svc.lifecycle).toBe(life);
    expect(await warmUp!).toEqual({
      items: [],
      end: { kind: "refused", status: 503, retryable: true, cause: "the service has not started", delivered: 0 },
    });
    expect(counts).toEqual([[0, false]]);
    // after the startup, the same transport serves through the same lifecycle
    expect(await given!.request("api", "GET /things", () => "later").collect()).toEqual({ items: ["later"], end: { kind: "done", delivered: 1 } });
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
  });

  it("gives the lifecycle to a transport that starts before any await of the startup", async () => {
    let seen: Lifecycle | null = null;
    let inStart: Lifecycle | null = null;
    // no health server and no dependency: the transport starts in the same turn as run()
    const svc: ServiceBuilder = service("bare").profile(ephemeral);
    svc.server("cli", {}, {
      start: (_signal, life) => {
        seen = life;
        inStart = svc.lifecycle;
      },
      stopIntake() {},
      drain() {},
      inFlight: () => 0,
      close() {},
    });
    svc.controller("command").route("RUN", { idempotent: false });
    const { life, exit } = await runOn(svc);
    expect(seen).toBe(life);
    expect(inStart).toBe(life);
    void life.shutdown();
    expect(await exit()).toBe(0);
  });
});

describe("a transport that asks for the shutdown in its start (SYS-15)", () => {
  it("gets its shutdown after the startup ends, also when it starts in the same turn as run()", async () => {
    const svc: ServiceBuilder = service("stream").profile(ephemeral);
    let startedSeen: Promise<void> | null = null;
    svc.server("stdio", {}, {
      start: (_signal, life) => {
        // the input of a stdio transport can end at once: the transport asks for the shutdown
        startedSeen = life.started;
        void life.shutdown("the input ended");
      },
      stopIntake() {},
      drain() {},
      inFlight: () => 0,
      close() {},
    });
    svc.controller("tools").route("tools/call", { idempotent: false });
    const { life, events, exit } = await runOn(svc);
    expect(startedSeen).toBe(life.started);
    expect(await exit()).toBe(0);
    const opened = events.findIndex((event) => event.machine === "gate" && event.to === "open");
    const drained = events.findIndex((event) => event.machine === "drain");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(drained).toBeGreaterThan(opened);
  });
});

describe("the policy of a repeat signal (SYS-9)", () => {
  it("with exit, exits 1 at once on a second SIGINT, and records exit.repeat", async () => {
    const r = rig();
    r.svc.onRepeatSignal("exit");
    expect(r.svc.describe().shutdown.onRepeatSignal).toBe("exit");
    const life = await run(r);
    void life.request("api", "GET /things", () => new Promise<string>(() => {}));
    r.process.signal("SIGINT");
    await r.clock.advance(500);
    const at = r.clock.now();
    r.process.signal("SIGINT");
    expect(r.process.exits).toEqual([1]);
    expect(life.exitCode).toBe(1);
    expect(life.state).toBe("exited");
    expect(await life.done).toBe(1);
    expect(r.process.handlers).toBe(0);
    const repeat = r.events.find((event) => event.on === "exit.repeat")!;
    expect(repeat).toMatchObject({ from: "stopping", to: "exited", detail: "exit 1", at });
    expect(life.errors).toEqual(["SIGINT came again while the shutdown ran, and the declaration exits at once"]);
    // the rest of the sequence ends no process again
    await r.clock.advance(20_000);
    expect(r.process.exits).toEqual([1]);
    expect(r.clock.pending).toBe(0);
  });

  it("with ignore, keeps the behavior of 0.4: one shutdown and one exit", async () => {
    const r = rig();
    r.svc.onRepeatSignal("ignore");
    expect(r.svc.describe().shutdown.onRepeatSignal).toBe("ignore");
    const life = await run(r);
    r.process.signal("SIGINT");
    await r.clock.advance(500);
    r.process.signal("SIGINT");
    expect(await exited(r, life)).toBe(0);
    expect(r.process.exits).toEqual([0]);
    expect(exitSteps(r.events)).toEqual([
      "running -> stopping on exit.request",
      "stopping -> stopping on exit.repeat",
      "stopping -> exited on shutdown.done",
    ]);
  });

  it("is necessary: describe() and run() refuse a declaration without it, and lint() names a description without it", async () => {
    const bare = () =>
      service("bare")
        .readiness({ type: "window", failAfter: s(0) })
        .liveness({ type: "window", failAfter: s(0) })
        .startup(s(1))
        .phase("drain", s(1))
        .cooperativeWindow(s(1));
    expect(() => bare().describe()).toThrow(/bare does not declare what a repeat signal does, "ignore" or "exit" \(svc.onRepeatSignal\): the runtime has no defaults/);
    await expect(bare().run({ process: fakeProcess() })).rejects.toThrow(/what a repeat signal does/);
    const scenario = podScenario(30, 0);
    const declared = bare().onRepeatSignal("exit").describe();
    expect(lint(declared, scenario, [O10]).map((finding) => finding.rule)).toEqual(["O10"]);
    // a description from another source, for example the JSON of 0.4, can lack the field
    const { onRepeatSignal: _dropped, ...shutdown } = declared.shutdown;
    const old = { ...declared, shutdown } as unknown as typeof declared;
    const [finding, ...rest] = lint(old, scenario, [O10]);
    expect(finding).toMatchObject({ rule: DECLARATION_RULE, scope: "bare", verdict: "depends", unbound: ["shutdown.onRepeatSignal"] });
    expect(rest.map((each) => each.rule)).toEqual(["O10"]);
  });

  it("with exit, exits at once on a signal during the startup after a first request", async () => {
    const r = rig({ connect: { db: 2000 } });
    r.svc.onRepeatSignal("exit");
    let sent = 0;
    const life = await run(r, (at) => {
      if (at >= 500 && sent === 0) {
        sent = 1;
        r.process.signal("SIGTERM");
      } else if (at >= 1000 && sent === 1) {
        sent = 2;
        r.process.signal("SIGTERM");
      }
    });
    expect(await life.done).toBe(1);
    expect(r.process.exits).toEqual([1]);
    await r.clock.advance(20_000);
    expect(r.process.exits).toEqual([1]);
    // the shutdown does not start after a process that exited
    expect(r.events.some((event) => event.machine === "drain")).toBe(false);
    expect(r.clock.pending).toBe(0);
  });

  it("with exit, ignores a repeat shutdown() and a process trigger: only a signal insists", async () => {
    const r = rig();
    r.svc.onRepeatSignal("exit").trigger("stdin-close");
    const life = await run(r);
    r.process.signal("SIGTERM");
    await r.clock.advance(100);
    // a stdio parent closes stdin when it stops its child: that is not a second request
    r.process.trigger("stdin-close");
    void life.shutdown("again");
    expect(await exited(r, life)).toBe(0);
    expect(r.process.exits).toEqual([0]);
    expect(r.events.filter((event) => event.on === "exit.repeat").map((event) => event.to)).toEqual(["stopping", "stopping"]);
  });
});

describe("profiles as data (SYS-10)", () => {
  const block = [
    ["fail readiness", 2],
    ["stop intake", 5],
    ["drain", 15],
    ["close transports", 2],
    ["stop the poller", 1],
    ["tear down dependencies", 2],
    ["close the health server", 1],
  ] as const;
  const policies = (svc: ServiceBuilder): ServiceBuilder =>
    svc
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(120))
      .couple({ from: "liveness", to: "readiness", effect: "fails" });

  it("gives the phase block of jarvis and of the kind lab at the defaults of Kubernetes", () => {
    const byHand = policies(service("jarvis"));
    for (const [name, cap] of block) byHand.phase(name, s(cap));
    byHand.cooperativeWindow(s(5)).onRepeatSignal("ignore");
    const byProfile = policies(service("jarvis")).profile(kubernetes({ grace: s(30), preStop: s(0) }));
    const hand = byHand.describe();
    const profiled = byProfile.describe();
    expect(profiled.shutdown.phases).toEqual(hand.shutdown.phases);
    expect(profiled.shutdown.cooperativeWindow).toEqual(hand.shutdown.cooperativeWindow);
    // the profile also says the floor of 0.4, and that the repeat SIGTERM of a pod has no effect
    expect(profiled.shutdown).toMatchObject({ cooperativeFloor: "half", onRepeatSignal: "ignore" });
    expect({ ...profiled, shutdown: null }).toEqual({ ...hand, shutdown: null });
  });

  it("derives the caps from the grace less the preStop sleep, and each one meets O10 and O16", () => {
    for (const [grace, preStop] of [
      [30, 0],
      [30, 5],
      [60, 10],
      [7, 0],
      [3600, 30],
    ] as const) {
      const profile = kubernetes({ grace: s(grace), preStop: s(preStop) });
      const sum = profile.phases!.reduce((total, phase) => total + valueIn(phase.cap, "ms"), 0);
      const budget = (grace - preStop) * 1000;
      expect(sum, `grace ${grace} s, preStop ${preStop} s`).toBeLessThanOrEqual((budget * 28) / 30);
      expect(sum, `grace ${grace} s, preStop ${preStop} s`).toBeGreaterThan((budget * 28) / 30 - 7);
      const svc = policies(service("pod")).profile(profile);
      const findings = lint(svc.describe(), podScenario(grace, preStop), [O10, O16]);
      expect(findings.map((finding) => finding.verdict), `grace ${grace} s, preStop ${preStop} s`).toEqual(["holds", "holds"]);
    }
    // each cap is a whole number of milliseconds
    const odd = kubernetes({ grace: s(31), preStop: s(0) });
    expect(odd.phases![0]!.cap).toEqual(s(2.066));
    expect(odd.cooperativeWindow).toEqual(s(5.166));
  });

  it("refuses a pod whose grace is not longer than its preStop sleep, or an amount that is not a time", () => {
    expect(() => kubernetes({ grace: s(5), preStop: s(5) })).toThrow(/is not longer than its preStop sleep/);
    expect(() => kubernetes({ grace: { value: 3, unit: "count" }, preStop: s(0) })).toThrow(/grace of the pod is not a time/);
    expect(() => kubernetes({ grace: s(30), preStop: s(-1) })).toThrow(/less than 0/);
  });

  it("lets a caller change a field with a spread, and refuses a second set of phases", () => {
    const changed: Profile = { ...localDev, onRepeatSignal: "ignore", cooperativeWindow: s(1) };
    const svc = policies(service("dev")).profile(changed);
    expect(svc.describe().shutdown).toMatchObject({ onRepeatSignal: "ignore", cooperativeWindow: s(1) });
    expect(() => svc.profile(localDev)).toThrow(/already has a shutdown phase named stop intake/);
  });

  it("declares the policy of a repeat signal in each profile: an exit for a terminal, no effect for a supervised host", () => {
    expect([localDev, ephemeral, daemon, kubernetes({ grace: s(30), preStop: s(0) })].map((profile) => profile.onRepeatSignal)).toEqual([
      "exit",
      "exit",
      "ignore",
      "ignore",
    ]);
  });

  it("gives a background host the caps of local development, no effect for a repeat signal, and no process trigger", () => {
    expect(daemon.phases).toEqual(localDev.phases);
    expect(daemon.phases).not.toBe(localDev.phases);
    expect(daemon.cooperativeWindow).toEqual(localDev.cooperativeWindow);
    expect(daemon.onRepeatSignal).toBe("ignore");
    expect(daemon.triggers).toBeUndefined();
    const svc = service("host")
      .profile(daemon)
      .readiness({ type: "window", failAfter: s(0) })
      .liveness({ type: "window", failAfter: s(0) })
      .startup(s(10));
    expect(svc.describe().shutdown).toMatchObject({ onRepeatSignal: "ignore" });
    expect(svc.describe().shutdown).not.toHaveProperty("triggers");
  });

  it("gives local development 10 s of caps, no readiness hold, and an exit on a second signal", () => {
    const sum = localDev.phases!.reduce((total, phase) => total + valueIn(phase.cap, "s"), 0);
    expect(sum).toBe(10);
    expect(localDev.phases!.some((phase) => phase.name === "fail readiness")).toBe(false);
    expect(localDev.onRepeatSignal).toBe("exit");
  });

  it("gives the floor of the cooperative abort to the drain document", () => {
    const r = rig({ window: s(4) });
    const values = (name: string) => (name === "drain_cap" ? s(CAPS.drain) : name === "cooperative_window" ? s(4) : undefined);
    expect(valueIn(timerOf(drainMachine(r.svc.describe()), "cooperative_abort", values).duration as never, "ms")).toBe(2000);
    r.svc.cooperativeFloor("none");
    expect(valueIn(timerOf(drainMachine(r.svc.describe()), "cooperative_abort", values).duration as never, "ms")).toBe(0);
  });
});

describe("process triggers and a minimal declaration (SYS-7)", () => {
  /** This function declares a stdio child: the minimal profile, the stdin trigger, and one transport. */
  const stdioChild = (log: string[]): ServiceBuilder => {
    const stdio: TransportImpl = {
      start: () => void log.push("start stdio"),
      stopIntake: () => void log.push("stop intake stdio"),
      drain: () => void log.push("drain stdio"),
      inFlight: () => 0,
      close: () => void log.push("close stdio"),
    };
    const svc = service("mcp").profile({ ...ephemeral, triggers: ["stdin-close"] }).server("stdio", {}, stdio);
    svc.controller("tools").route("tools/call", { idempotent: false });
    return svc;
  };

  it("stops through the staged shutdown when stdin closes, and exits 0", async () => {
    const log: string[] = [];
    const { life, process, events, exit } = await runOn(stdioChild(log));
    expect(process.triggers).toEqual(["SIGINT", "SIGTERM", "SIGQUIT", "stdin-close"]);
    process.trigger("stdin-close");
    expect(await exit()).toBe(0);
    expect(life.errors).toEqual([]);
    expect(log).toEqual(["start stdio", "stop intake stdio", "drain stdio", "close stdio"]);
    expect(events.find((event) => event.on === "exit.request")?.detail).toBe("stdin-close");
    expect(process.flushes).toBe(1);
    expect(process.exits).toEqual([0]);
  });

  it("adds no handler for a process trigger that the declaration does not name", async () => {
    const r = rig();
    const life = await run(r);
    expect(r.process.triggers).toEqual(["SIGINT", "SIGTERM", "SIGQUIT"]);
    void life.shutdown();
    await exited(r, life);
  });

  it("passes describe() and lint() as the minimal declaration of the README", () => {
    const description = stdioChild([]).describe();
    expect(description.shutdown.triggers).toEqual(["stdin-close"]);
    const findings = lint(description, podScenario(30, 0), [O10, O16]);
    expect(findings.map((finding) => finding.verdict)).toEqual(["holds", "holds"]);
  });

  it("refuses an unknown trigger, and an exit code that a process cannot give or that names no trigger", () => {
    const base = () => service("x").profile(ephemeral);
    expect(() => base().trigger("stdin-gone" as never).describe()).toThrow(/stdin-gone is not a process trigger/);
    expect(() => base().exitCode("SIGINT", 256).describe()).toThrow(/exit code of SIGINT is 256, not a whole number/);
    expect(() => base().exitCode("SIGINT", 1.5).describe()).toThrow(/not a whole number/);
    expect(() => base().exitCode("stdin-close", 0).describe()).toThrow(/names no exit signal and no declared trigger/);
    expect(base().trigger("stdin-close").exitCode("stdin-close", 0).describe().shutdown.exitCodes).toMatchObject({ "stdin-close": 0 });
  });
});

describe("run() for a process that runs one command (SYS-16)", () => {
  const command = (): ServiceBuilder => {
    const svc = service("tool").profile(ephemeral);
    svc.controller("command").route("RUN", { idempotent: false });
    return svc;
  };

  it("exits with the code that its work gives", async () => {
    for (const code of [0, 2, 3]) {
      const { life, process, exit } = await runOn(command());
      const outcome = await life.request("command", "RUN", () => code).collect();
      expect(outcome).toEqual({ items: [code], end: { kind: "done", delivered: 1 } });
      void life.shutdown("the command ended", { code });
      expect(await exit()).toBe(code);
      expect(process.exits).toEqual([code]);
    }
  });

  it("keeps the code 1 for an error when the work gives 0, and the code of the work over an error", async () => {
    for (const [given, expected] of [
      [0, 1],
      [4, 4],
    ] as const) {
      const svc = command();
      svc.onPhase("tear down dependencies", () => {
        throw new Error("the cache did not close");
      });
      const { life, exit } = await runOn(svc);
      void life.shutdown("the command ended", { code: given });
      expect(await exit()).toBe(expected);
      expect(life.errors).toEqual(["the phase tear down dependencies failed: the cache did not close"]);
    }
  });

  it("refuses an exit code that a process cannot give", async () => {
    const { life, exit } = await runOn(command());
    await expect(life.shutdown("no", { code: 300 })).rejects.toThrow(/not a whole number from 0 to 255/);
    await expect(life.shutdown("no", { code: -1 })).rejects.toThrow(/not a whole number from 0 to 255/);
    void life.shutdown();
    expect(await exit()).toBe(0);
  });

  it("aborts the work at once on a first Ctrl-C, and exits 130", async () => {
    const { life, clock, process, events, exit } = await runOn(command());
    let abortedAt: number | null = null;
    const work = life
      .request(
        "command",
        "RUN",
        (signal) =>
          new Promise<number>((_, reject) =>
            signal.addEventListener("abort", () => {
              abortedAt = clock.now();
              reject(new Error("interrupted"));
            }),
          ),
      )
      .collect();
    await clock.advance(1000);
    const at = clock.now();
    process.signal("SIGINT");
    // the outcome comes in the same turn of the clock: nothing waits for a cap
    await clock.advance(0);
    expect(abortedAt).toBe(at);
    expect(drainEnter(events, "drain").at).toBe(at);
    expect((await work).end).toMatchObject({ kind: "cut", status: 500, retryable: false, delivered: 0 });
    // the work gives its own code after the interrupt, and the code of SIGINT stays
    void life.shutdown("the command was interrupted", { code: 1 });
    expect(await exit()).toBe(130);
    expect(process.exits).toEqual([130]);
  });

  it("exits 143 after SIGTERM and 131 after SIGQUIT with the minimal profile, and 0 without exit codes", async () => {
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGQUIT", 131],
    ] as const) {
      const { process, exit } = await runOn(command());
      process.signal(signal);
      expect(await exit()).toBe(code);
    }
    const r = rig();
    const life = await run(r);
    r.process.signal("SIGINT");
    expect(await exited(r, life)).toBe(0);
  });

  it("waits for the output before the exit: the flush ends, and then the process exits", async () => {
    const r = rig({ caps: { ...CAPS, "flush the output": 1 }, flush: 300 });
    const written: string[] = [];
    r.svc.onPhase("flush the output", async ({ clock }) => {
      // a log exporter writes its last lines before the port writes the output
      await new Promise<void>((resolve) => clock.after(100, resolve));
      written.push(`${clock.now()} the last log lines`);
    });
    const life = await run(r);
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    const enter = drainEnter(r.events, "flush the output").at;
    expect(written).toEqual([`${enter + 100} the last log lines`]);
    expect(r.process.log).toEqual([`${enter + 100} flush`, `${enter + 400} flushed`, `${enter + 400} exit 0`]);
    expect(r.process.flushes).toBe(1);
  });

  it("exits 1 when the flush does not end in its cap, and does not wait longer", async () => {
    const r = rig({ caps: { ...CAPS, "flush the output": 1 }, flush: 5000 });
    const life = await run(r);
    void life.shutdown();
    expect(await exited(r, life)).toBe(1);
    const enter = drainEnter(r.events, "flush the output").at;
    expect(r.process.log.at(-1)).toBe(`${enter + 1000} exit 1`);
    expect(life.errors).toEqual(["the phase flush the output did not end in its cap of 1 s"]);
  });

  it("exits without a wait for the output when the declaration has no flush phase, as 0.4 did", async () => {
    const r = rig();
    const life = await run(r);
    void life.shutdown();
    expect(await exited(r, life)).toBe(0);
    expect(r.process.flushes).toBe(0);
  });
});
