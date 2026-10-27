import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITER_CELLS, LIMITER_SERVICE, LIMITER_SPECS, limiterPrediction, limiterTarget, retryPlan } from "./limiter.ts";

/** The check of the declaration of the target, from its script. The import has no types, thus this type gives them. */
interface TargetLint {
  readonly specOf: (flags: Readonly<Record<string, number | string>>) => unknown;
  readonly lintTarget: (spec: unknown) => { readonly findings: ReadonlyArray<Record<string, unknown>>; readonly problems: readonly string[] };
}
const DECLARATION = new URL("../targets/service-limiter/declaration.mjs", import.meta.url).href;

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
});
