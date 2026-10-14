import { valueIn } from "@mark1russell7/quantity";
import type { ServiceBuilder } from "./builder.ts";
import type { Check, ServiceDescription } from "./description.ts";
import type { FakeClock } from "./fakes.ts";
import { fakeClock, seeded } from "./fakes.ts";
import type { Health, HealthVerdict, StartOptions } from "./health.ts";
import { failSpan, recoverSpan } from "./timing.ts";

/** A contract case is one generated case of the contract test of a declaration. It throws on a failure. */
export interface ContractCase {
  readonly name: string;
  run(): Promise<void>;
}

/** These options tune the contract test. */
export interface ContractOptions {
  /** This number is the latency that a degraded dependency adds to each check, in milliseconds. The default of the contract is 100. */
  readonly degradeBy?: number | undefined;
  /** This number is the seed of the jitter. */
  readonly seed?: number | undefined;
}

const ms = (amount: { readonly value: number; readonly unit: string }): number => valueIn(amount, "ms");

/** The part of a verdict that the contract compares: what a caller and the platform see. */
const visible = (verdict: HealthVerdict) => ({
  ready: verdict.ready,
  alive: verdict.alive,
  controllers: verdict.controllers,
  dependencies: verdict.dependencies,
});

const same = (expected: unknown, actual: unknown): boolean => JSON.stringify(expected) === JSON.stringify(actual);

const failure = (what: string, expected: unknown, actual: unknown): Error =>
  new Error(`${what}: expected ${JSON.stringify(expected)}, but the verdict was ${JSON.stringify(actual)}`);

/**
 * This function generates the contract test of a declaration. `declare` gives a new builder with
 * the declaration and the function of each check, each time. The checks must pass at rest. The
 * cases are:
 * - The service at rest: each controller and each dependency is ready, and the service is alive.
 * - Each dependency unavailable: its polls fail at once (the force-fail list). The dependency and
 *   each controller that needs it become not ready, and the other controllers stay ready. Liveness
 *   stays, unless a liveness check exercises the dependency.
 * - Each dependency degraded: each call of its checks takes the latency longer. Nothing can fail.
 * - Each dependency recovers: after it is unavailable, the service is again at rest.
 * - A negative control: a client that the declaration does not name fails, and nothing changes.
 *
 * A dependency that no check exercises is a finding: the service cannot see it fail.
 */
export const contractCases = (declare: () => ServiceBuilder, options: ContractOptions = {}): ContractCase[] => {
  const degradeBy = options.degradeBy ?? 100;
  const seed = options.seed ?? 1;
  const description: ServiceDescription = declare().describe();
  const service = description.name;
  const gating = description.checks.filter((check) => check.gates !== null);
  const timingOf = (check: Check) => description.policies[check.gates!];
  const failMax = (check: Check): number => ms(failSpan(timingOf(check), check.poll, "error").max);
  const recoverMax = (check: Check): number => ms(recoverSpan(timingOf(check), check.poll).max);
  const most = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), 0);
  const settleTime = most(gating.filter((check) => check.gates === "readiness").map(recoverMax)) + 1;
  const quietTime = most(gating.map(failMax)) + 1;

  /** This function starts the declaration on a fake clock, and moves it to rest. */
  const boot = async (
    extra: (clock: FakeClock) => Partial<StartOptions> = () => ({}),
  ): Promise<{ health: Health; clock: FakeClock; rest: ReturnType<typeof visible> }> => {
    const clock = fakeClock();
    // the warm-up sweep can wait on the clock (a degraded check), thus the clock moves while it starts
    const starting = declare().start({ clock, random: seeded(seed), ...extra(clock) });
    let started = false;
    void starting.then(
      () => (started = true),
      () => (started = true),
    );
    for (let step = 0; step < 1000 && !started; step += 1) await clock.advance(10);
    const health = await starting;
    await clock.advance(settleTime);
    return { health, clock, rest: visible(health.verdict()) };
  };
  const stop = (health: Health): void => health.stop();

  const cases: ContractCase[] = [
    {
      name: `${service}: at rest, each controller and each dependency is ready, and the service is alive`,
      async run() {
        const { health, rest } = await boot();
        try {
          const expected = {
            ready: true,
            alive: true,
            controllers: Object.fromEntries(description.controllers.map((each) => [each.name, true])),
            dependencies: Object.fromEntries(description.dependencies.map((each) => [each.name, true])),
          };
          if (!same(expected, rest)) throw failure("at rest", expected, rest);
        } finally {
          stop(health);
        }
      },
    },
  ];

  for (const dependency of description.dependencies) {
    const on = gating.filter((check) => check.dependency === dependency.name);
    const readiness = on.filter((check) => check.gates === "readiness");
    const liveness = on.filter((check) => check.gates === "liveness");
    const unavailable = (rest: ReturnType<typeof visible>) => ({
      ready: readiness.length === 0 ? rest.ready : false,
      alive: liveness.length === 0 ? rest.alive : false,
      controllers: Object.fromEntries(
        description.controllers.map((each) => [
          each.name,
          each.requires.includes(dependency.name) && readiness.length > 0 ? false : rest.controllers[each.name],
        ]),
      ),
      dependencies: { ...rest.dependencies, [dependency.name]: readiness.length === 0 },
    });

    cases.push({
      name: `${service}: ${dependency.name} unavailable`,
      async run() {
        if (on.length === 0)
          throw new Error(`no check that gates a policy exercises ${dependency.name}: the service cannot see it fail`);
        const { health, clock, rest } = await boot();
        try {
          health.forceFail(dependency.name, true);
          await clock.advance(most(on.map(failMax)) + 1);
          const now = visible(health.verdict());
          const expected = unavailable(rest);
          if (!same(expected, now)) throw failure(`${dependency.name} unavailable`, expected, now);
        } finally {
          stop(health);
        }
      },
    });

    cases.push({
      name: `${service}: ${dependency.name} degraded by ${degradeBy} ms, and nothing fails`,
      async run() {
        const tight = on.filter((check) => ms(check.poll.timeout) <= degradeBy);
        if (tight.length > 0)
          throw new Error(
            `${tight.map((check) => `${check.name} times out in ${ms(check.poll.timeout)} ms`).join(", ")}: a latency of ${degradeBy} ms fails it`,
          );
        const { health, clock, rest } = await boot((at) => ({
          wrapCheck: (check, run) =>
            check.dependency !== dependency.name
              ? run
              : (signal) => new Promise((resolve) => at.after(degradeBy, () => resolve(run(signal)))),
        }));
        try {
          await clock.advance(quietTime + most(on.map((check) => ms(check.poll.interval))));
          const now = visible(health.verdict());
          if (!same(rest, now)) throw failure(`${dependency.name} degraded`, rest, now);
        } finally {
          stop(health);
        }
      },
    });

    cases.push({
      name: `${service}: ${dependency.name} recovers`,
      async run() {
        if (on.length === 0)
          throw new Error(`no check that gates a policy exercises ${dependency.name}: the service cannot see it recover`);
        const { health, clock, rest } = await boot();
        try {
          health.forceFail(dependency.name, true);
          await clock.advance(most(on.map(failMax)) + 1);
          health.forceFail(dependency.name, false);
          await clock.advance(most(on.map(recoverMax)) + 1);
          const now = visible(health.verdict());
          if (!same(rest, now)) throw failure(`${dependency.name} recovered`, rest, now);
        } finally {
          stop(health);
        }
      },
    });
  }

  const never = `${service}.client-never-registered`;
  cases.push({
    name: `${service}: a client never registered fails, and nothing changes (the negative control)`,
    async run() {
      if (description.dependencies.some((each) => each.name === never))
        throw new Error(`the declaration has a dependency named ${never}`);
      const { health, clock, rest } = await boot();
      try {
        health.forceFail(never, true);
        await clock.advance(quietTime);
        const now = visible(health.verdict());
        if (!same(rest, now)) throw failure("the negative control", rest, now);
      } finally {
        stop(health);
      }
      // and a check on a client never registered is refused before the start
      let refused = false;
      try {
        declare()
          .check({
            name: `${never}.check`,
            dependency: never,
            step: "round-trip",
            ownConnection: true,
            gates: null,
            poll: gating[0]?.poll ?? { interval: { value: 1, unit: "s" }, jitter: 0, timeout: { value: 0.5, unit: "s" } },
          })
          .describe();
      } catch {
        refused = true;
      }
      if (!refused) throw new Error(`the declaration accepted a check on ${never}, which is not a dependency`);
    },
  });

  return cases;
};
