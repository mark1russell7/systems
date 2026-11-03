import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Measured } from "@mark1russell7/harness";
import { firstArm } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import {
  benchTimes,
  LIMITER_BUILD,
  LIMITER_CELLS,
  LIMITER_SERVICE,
  LIMITER_SPECS,
  limiterBench,
  limiterPrediction,
  limiterTarget,
  PAIR_ROUNDS,
  pairedLines,
  pairedTimeOf,
  pairOf,
  retryPlan,
} from "./limiter.ts";

/** The check of the declaration of the target, from its script. The import has no types, thus this type gives them. */
interface TargetLint {
  readonly specOf: (flags: Readonly<Record<string, number | string>>) => unknown;
  readonly lintTarget: (spec: unknown) => { readonly findings: ReadonlyArray<Record<string, unknown>>; readonly problems: readonly string[] };
}
const DECLARATION = new URL("../targets/service-limiter/declaration.mjs", import.meta.url).href;
const SERVER = new URL("../targets/service-limiter/server.mjs", import.meta.url);

/** SYS-28: the cells of the keyed limiter take their bands from the documents of the limiter and of the RetryAgent. */
describe("the cells of the keyed limiter", () => {
  it("plans the retries of the RetryAgent at its defaults against each window", () => {
    // a Retry-After of 30 s or less: the agent waits it, and the limiter lets the retry in (O30 holds)
    expect(retryPlan(30)).toEqual({ retryAfters: [30], delays: [30], letIn: true });
    expect(retryPlan(5)).toEqual({ retryAfters: [5], delays: [5], letIn: true });
    // 60 s: the cap sends the retry at 30 s, the limiter refuses it with Retry-After 30, and the next one gets in (O30 fails)
    expect(retryPlan(60)).toEqual({ retryAfters: [60, 30], delays: [30, 30], letIn: true });
    // 150 s is the window of five retries of 30 s (O29 holds at its border), and 151 s is past it (O29 fails)
    expect(retryPlan(150)).toEqual({ retryAfters: [150, 120, 90, 60, 30], delays: [30, 30, 30, 30, 30], letIn: true });
    expect(retryPlan(151)).toEqual({ retryAfters: [151, 121, 91, 61, 31], delays: [30, 30, 30, 30, 30], letIn: false });
  });

  it("gives each retry its band from the refusal before it, and the end of the cell", () => {
    const o302 = limiterPrediction(LIMITER_SPECS.find((spec) => spec.plan === "O30.2")!);
    expect(o302).toMatchObject({ detects: true, errno: "retry", from: "last-reply", driver: { socket: "pool", ends: { ev: "attempt", where: { i: 2, n: 2 } } } });
    const band = o302 as { low: { value: number }; high: { value: number } };
    // 30 s, early by at most the loop clock and one jiffy, late by the slack of epoll, the loop clock, a jiffy and the handling of the refusal
    expect(band.low.value).toBeLessThan(30);
    expect(band.low.value).toBeGreaterThan(29.99);
    expect(band.high.value).toBeGreaterThan(30.03);
    expect(band.high.value).toBeLessThan(30.05);
    const steps = (o302 as { driver: { then: Array<{ what: string; name: string; ends: { ev: string } }> } }).driver.then;
    expect(steps.map((step) => [step.name, step.ends.ev])).toEqual([
      ["retry", "attempt"],
      ["200", "response"],
    ]);
    const o292 = limiterPrediction(LIMITER_SPECS.find((spec) => spec.plan === "O29.2")!) as { driver: { then: Array<{ name: string }>; quiet: unknown[] } };
    expect(o292.driver.then.map((step) => step.name)).toEqual(["retry", "retry", "retry", "retry", "UND_ERR_REQ_RETRY"]);
    expect(o292.driver.quiet).toEqual([{ ev: "attempt", where: { i: 2, n: 7 }, name: "why" }]);
    // a client that does not retry gives the 429 to the caller at once
    expect(limiterPrediction(LIMITER_SPECS.find((spec) => spec.plan === "O29.4")!)).toMatchObject({ errno: "429", from: "request-sent", driver: { quiet: [{ ev: "retry", where: { i: 2 } }] } });
  });

  it("names each cell by its plan, builds its target from a pinned context, and keys each client", () => {
    expect(LIMITER_CELLS.map((cell) => cell.name.split(" ")[0])).toEqual(["O30.1", "O30.2", "O29.1", "O29.2", "O29.3", "O29.4"]);
    const target = limiterTarget(30);
    expect(target.command).toContain("--window-ms");
    expect(target.command[target.command.indexOf("--window-ms") + 1]).toBe("30000");
    const subject = target.subject as { kind: string; context: string; files: string[] };
    expect(subject.kind).toBe("build");
    for (const file of subject.files) expect(existsSync(join(subject.context, file)), file).toBe(true);
    for (const cell of LIMITER_CELLS) expect(cell.probe.http?.options?.["limiter-key"], cell.name).toBe(1);
    expect(LIMITER_CELLS.filter((cell) => cell.probe.http?.options?.["retry"] === 1).length).toBe(4);
  });

  it("names the version of the service of the target in each cell, as its package and its lockfile pin it", () => {
    const context = (limiterTarget(30).subject as { context: string }).context;
    const manifest = JSON.parse(readFileSync(join(context, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(context, "npm-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    expect(manifest.dependencies["@mark1russell7/service"]).toBe(LIMITER_SERVICE);
    expect(lock.packages["node_modules/@mark1russell7/service"]?.version).toBe(LIMITER_SERVICE);
    for (const cell of LIMITER_CELLS) expect(cell.name, cell.name).toContain("to the keyed limiter of service 0.6,");
  });

  it("lints the declaration of the target for each cell: O29 and O30 depend on the caller, and nothing else is found", async () => {
    const { lintTarget, specOf } = (await import(DECLARATION)) as TargetLint;
    for (const spec of LIMITER_SPECS) {
      const checked = lintTarget(specOf({ policy: "sliding-window", limit: 1, windowMs: spec.window * 1000, maxKeys: 100 }));
      expect(checked.problems, spec.plan).toEqual([]);
      expect(checked.findings.map((finding) => [finding["rule"], finding["verdict"], finding["limiter"]]), spec.plan).toEqual([
        ["O29", "depends", [spec.window, spec.window]],
        ["O30", "depends", [spec.window]],
      ]);
    }
    // a token bucket of 3 at 1 each second: a refusal waits 1 s at most, and a new key at the cap 3 s
    const bucket = lintTarget(specOf({ policy: "token-bucket", ratePerS: 1, burst: 3, maxKeys: 100 }));
    expect(bucket.problems).toEqual([]);
    expect(bucket.findings.map((finding) => finding["limiter"])).toEqual([[1, 3], [1]]);
  });

  it("reads the spec without the service, and loads the check only if --lint is not off", () => {
    const server = readFileSync(SERVER, "utf8");
    expect(server).toContain('import { LIMITER, specOf } from "./spec.mjs";');
    expect(server).not.toMatch(/^import .*declaration[.]mjs/m);
    expect(server).toContain('flag("--lint") === "off"');
    expect(readFileSync(new URL("../targets/service-limiter/spec.mjs", import.meta.url), "utf8")).not.toMatch(/^import /m);
    expect((limiterTarget(30).subject as { files: string[] }).files).toContain("spec.mjs");
    expect(limiterTarget(30).command).not.toContain("--lint");
  });

  it("builds the rounds of a pair: the A/B pair and the A/A pair of each spec, with the order of firstArm, on the same shard", () => {
    const builds = pairOf("0.5.6,0.6.0", "/pair");
    expect(builds.map((build) => [build.service, build.label, build.lint])).toEqual([
      ["0.5.6", "0.5.6", false],
      ["0.6.0", "0.6.0", true],
    ]);
    for (const shards of [1, 2, 3, 6]) {
      const bench = limiterBench(builds, shards);
      // 6 specs, 7 rounds, 2 pairs of 2 arms
      expect(bench.length).toBe(6 * PAIR_ROUNDS * 4);
      expect(new Set(bench.map((each) => each.cell.name)).size).toBe(bench.length);
      // the runner gives cell k of the selection to shard k % n (run.test.ts): each spec stays on one shard
      bench.forEach((each, at) => expect(at % shards, each.cell.name).toBe(each.slot.offset % shards));
      for (const [offset, spec] of LIMITER_SPECS.entries()) {
        const own = bench.filter((each) => each.slot.offset === offset);
        expect(own.every((each) => each.cell.name.startsWith(`${spec.plan} `) && each.slot.plan === spec.plan)).toBe(true);
        // each round runs the A/B pair, then the A/A pair, and the first arm of each pair is firstArm(round, offset)
        expect(own.map((each) => [each.slot.round, each.slot.block, each.slot.arm])).toEqual(
          Array.from({ length: PAIR_ROUNDS }, (_, round) => {
            const first = firstArm(round, offset);
            const second = first === "a" ? "b" : "a";
            return [[round, "ab", first], [round, "ab", second], [round, "aa", first], [round, "aa", second]];
          }).flat(),
        );
        // the order turns each round: a pair starts with each arm in 3 or 4 of its 7 rounds
        const firsts = own.filter((each) => each.slot.block === "ab" && each.slot.arm === "a").map((each) => each.slot.first);
        expect(Math.abs(firsts.filter((arm) => arm === "a").length * 2 - PAIR_ROUNDS)).toBe(1);
        for (const each of own) {
          // arm b of the A/B pair is the candidate, and each other arm is the control
          const candidate = each.slot.block === "ab" && each.slot.arm === "b";
          expect(each.slot.service, each.cell.name).toBe(candidate ? "0.6.0" : "0.5.6");
          expect([each.cell.runs, each.cell.environments]).toEqual([1, 1]);
          expect(each.cell.prediction).toEqual(limiterPrediction(spec));
          const subject = each.cell.target.subject as { name: string; context: string };
          expect([subject.name, subject.context]).toEqual([`service-limiter-${each.slot.service}`, join("/pair", each.slot.service)]);
          // only the candidate checks its declaration: the control can lack that lint()
          if (candidate) expect(each.cell.target.command).not.toContain("--lint");
          else expect(each.cell.target.command.slice(-2)).toEqual(["--lint", "off"]);
          expect(each.cell.name).toContain(`service ${each.slot.service}, `);
          expect(each.cell.name).toMatch(new RegExp(`[(]${each.slot.block === "ab" ? "A/B" : "A/A"} round ${each.slot.round + 1}, arm ${each.slot.arm}[)]$`));
        }
      }
    }
    // a selection keeps the pairs: O30 on 2 shards
    expect(new Set(limiterBench(builds, 2, /^O30[.]/).map((each) => each.slot.plan))).toEqual(new Set(["O30.1", "O30.2"]));
    // a count of shards that does not divide the specs puts the cells of a spec on two runners
    expect(() => limiterBench(builds, 4)).toThrow(/divides 6/);
    expect(() => limiterBench(builds, 3, /^O30[.]/)).toThrow(/divides 2/);
    expect(() => limiterBench(builds, 1, /service 0[.]6[.]0/)).toThrow(/selection/);
    expect(() => limiterBench(builds, 1, /./, 1)).toThrow(/2 rounds or more/);
    for (const bad of ["0.6.0", "0.6.0,0.6.0", "^0.5.6,0.6.0", "0.5,0.6.0", "0.5.6,0.6.0,0.7.0"]) expect(() => pairOf(bad, "/pair"), bad).toThrow(/two different versions/);
    // the standing catalog keeps its target
    expect(LIMITER_CELLS.every((cell) => (cell.target.subject as { name: string }).name === "service-limiter")).toBe(true);
    expect(LIMITER_BUILD).toMatchObject({ service: LIMITER_SERVICE, label: "0.6", lint: true });
  });

  it("gives a time of each band of a run, and the PairedTime lines of the two arms of a pair", () => {
    const spec = (plan: string) => LIMITER_SPECS.find((each) => each.plan === plan)!;
    const at = (value: number) => ({ value, unit: "s" });
    const run = (elapsed: number | null, steps: (number | null)[], voided: string | null = null) =>
      ({ elapsed: elapsed === null ? null : at(elapsed), driver: { steps: steps.map((value) => ({ what: "", name: null, elapsed: value === null ? null : at(value) })) }, void: voided }) as unknown as Measured;
    // O30.2: retry 1 is the first band, retry 2 is a later band, and the 200 is the answer
    expect(benchTimes(spec("O30.2"), run(30.0044, [30.0037, 0.0003]))).toEqual([
      { case: "O30.2 retry 1", measure: "retry", time: at(30.0044) },
      { case: "O30.2 retry 2", measure: "retry", time: at(30.0037) },
      { case: "O30.2 answer", measure: "answer", time: at(0.0003) },
    ]);
    expect(benchTimes(spec("O29.2"), run(30, [30, 30, 30, 30, 0.0004])).map((each) => each.case)).toEqual([
      "O29.2 retry 1", "O29.2 retry 2", "O29.2 retry 3", "O29.2 retry 4", "O29.2 retry 5", "O29.2 answer",
    ]);
    // a client that does not retry: the 429 is the answer
    expect(benchTimes(spec("O29.4"), run(0.0019, []))).toEqual([{ case: "O29.4 answer", measure: "answer", time: at(0.0019) }]);
    // a void run and a band that never came give no time
    expect(benchTimes(spec("O29.4"), run(0.0019, [], "the prober dropped 3 records"))).toEqual([]);
    expect(benchTimes(spec("O30.1"), run(null, [0.0003])).map((each) => each.case)).toEqual(["O30.1 answer"]);

    const bench = limiterBench(pairOf("0.5.6,0.6.0", "/pair"), 6);
    const slotOf = (arm: "a" | "b", round = 2) => bench.find((each) => each.slot.plan === "O30.1" && each.slot.block === "aa" && each.slot.round === round && each.slot.arm === arm)!.slot;
    const a = { slot: slotOf("a"), times: benchTimes(spec("O30.1"), run(30.007, [0.0003])) };
    const b = { slot: slotOf("b"), times: benchTimes(spec("O30.1"), run(30.008, [null])) };
    // the order of the arguments does not count, and a case that one arm did not time gets no line
    expect(pairedLines(b, a)).toEqual([{ pair: "aa", measure: "retry", case: "O30.1 retry 1", round: 2, first: "a", a: at(30.007), b: at(30.008) }]);
    expect(pairedLines(a, b).map(pairedTimeOf)).toEqual([{ case: "O30.1 retry 1", round: 2, first: "a", a: 30.007, b: 30.008 }]);
    expect(() => pairedLines(a, { ...b, slot: slotOf("b", 3) })).toThrow(/not the two arms of one pair/);
    expect(() => pairedLines(a, a)).toThrow(/not the two arms of one pair/);
    // rigor-bench refuses a time that is not above 0
    expect(() => pairedLines(a, { ...b, times: [{ case: "O30.1 retry 1", measure: "retry", time: at(0) }] })).toThrow(RangeError);
  });
});
