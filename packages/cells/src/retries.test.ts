import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import type { Chain } from "./retries.ts";
import { COUNT_CELLS, COUNT_SPECS, chainArgument, delaysOf, lawOf, triesOf } from "./retries.ts";

/** This function gives the spec of a plan. */
const spec = (plan: string) => {
  const found = COUNT_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

describe("the law of a chain", () => {
  it("gives a RetryAgent 1 + maxRetries tries for a status of its list and for a close", () => {
    expect(triesOf({ kind: "undici" }, "GET", 503)).toBe(6);
    expect(triesOf({ kind: "undici" }, "GET", "close")).toBe(6);
    expect(triesOf({ kind: "undici", maxRetries: 2 }, "GET", 429)).toBe(3);
  });

  it("gives a RetryAgent 1 try for a method or a status out of its lists", () => {
    expect(triesOf({ kind: "undici" }, "POST", 503)).toBe(1);
    expect(triesOf({ kind: "undici" }, "POST", "close")).toBe(1);
    expect(triesOf({ kind: "undici" }, "GET", 501)).toBe(1);
  });

  it("gives the Transport of Go 1 try for a status, and 2 for a GET that meets a close", () => {
    expect(triesOf({ kind: "go" }, "GET", 503)).toBe(1);
    expect(triesOf({ kind: "go" }, "GET", "close")).toBe(2);
    expect(triesOf({ kind: "go" }, "POST", "close")).toBe(1);
  });

  it("gives retry of the service its tries, for an answer of 500 or more", () => {
    expect(triesOf({ kind: "service", tries: 3, base: 1 }, "GET", 503)).toBe(3);
    expect(triesOf({ kind: "service", tries: 3, base: 1 }, "GET", 400)).toBe(1);
  });

  it("multiplies the tries from the client to the target", () => {
    const chain: Chain = { method: "GET", client: { kind: "undici" }, hops: [{ kind: "service", tries: 3, base: 1 }, { kind: "undici" }], failure: 503 };
    expect(lawOf(chain)).toEqual({ tries: [6, 3, 6], arrivals: [6, 18, 108] });
  });

  it("reads each caller against the answer of the listener below it", () => {
    const stopped: Chain = { method: "GET", client: { kind: "undici" }, hops: [{ kind: "undici", answer: 501 }], failure: 503 };
    expect(lawOf(stopped)).toEqual({ tries: [1, 6], arrivals: [1, 6] });
    const closed: Chain = { method: "GET", client: { kind: "go" }, hops: [{ kind: "undici" }], failure: "close" };
    expect(lawOf(closed)).toEqual({ tries: [1, 6], arrivals: [1, 6] });
  });

  it("gives the delays of a RetryAgent at its defaults: 15.5 s", () => {
    expect(delaysOf({ kind: "undici" })).toBe(15.5);
  });
});

describe("the cells of the retry count", () => {
  it("has the exact product at the target of each cell", () => {
    const products = Object.fromEntries(COUNT_SPECS.map((each) => [each.plan, lawOf(each.chain).arrivals.at(-1)]));
    expect(products).toEqual({
      "T14.count.1": 6,
      "T14.count.2": 36,
      "T14.count.3": 36,
      "T14.count.4": 108,
      "T14.count.5": 6,
      "T14.count.6": 1,
      "T14.count.7": 6,
      "T14.count.8": 36,
      "T14.count.9": 2,
    });
  });

  it("gives each listener its own count, and the same chain at two delays the same counts", () => {
    const counts = (plan: string) => {
      const cell = COUNT_CELLS.find((each) => each.name.startsWith(`${plan} `));
      if (cell?.prediction.detects !== null) throw new Error(`no counts for ${plan}`);
      return cell.prediction.counts;
    };
    expect(counts("T14.count.4")?.map((each) => [each.match.where?.["hop"], each.count])).toEqual([[0, 6], [1, 18], [2, 108]]);
    expect(counts("T14.count.3")?.map((each) => each.count)).toEqual(counts("T14.count.2")?.map((each) => each.count));
  });

  it("keeps the longest chain at its defaults inside its window and inside the deadline of the client", () => {
    const { chain, window } = spec("T14.count.2");
    const hop = delaysOf({ kind: "undici" });
    // the hop gives up after its delays, 6 times, and the client adds its own delays
    expect(6 * hop + delaysOf({ kind: "undici" })).toBe(108.5);
    expect(chain.hops).toHaveLength(1);
    expect(window).toBeGreaterThan(108.5);
  });

  it("gives the program of the target only what it reads", () => {
    expect(chainArgument(spec("T14.count.7").chain)).toEqual({ hops: [{ kind: "undici", options: { minTimeout: 1 }, answer: 501 }], failure: 503 });
    expect(chainArgument(spec("T14.count.4").chain)).toEqual({
      hops: [
        { kind: "service", tries: 3, base: 1 },
        { kind: "undici", options: { minTimeout: 1 } },
      ],
      failure: 503,
    });
  });

  it("pins the versions that the law cites", () => {
    const manifest = JSON.parse(readFileSync(new URL("../targets/retry-chain/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["undici"]).toBe("8.12.2");
    expect(manifest.dependencies["@mark1russell7/service"]).toBe("0.6.5");
  });

  it("is in the catalog", () => {
    for (const cell of COUNT_CELLS) expect(ALL).toContain(cell);
  });
});
