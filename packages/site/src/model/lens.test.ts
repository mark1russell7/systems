import { quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { bandOf, controlsOf, lanesOf, memo, type Lane, type Lens } from "./lens.ts";
import { DEFAULTS, LENSES, PRESETS, lensOf, requestPath, type Settings } from "./request.ts";

const lane = (id: string): Lane => ({ id, verdict: "blind", band: null, summary: id, facts: [], marks: [], measured: [], warning: null });
const names = { title: "x", label: "x", short: "x", term: null };

describe("the lens contract", () => {
  it("shows each knob once, on the first lens that names it", () => {
    interface Both {
      readonly rtt: number;
      readonly hz: number;
      readonly backlog: number;
    }
    const a: Lens<Both> = { id: "a", names, knobs: ["rtt", "hz"], lanes: () => [lane("a")] };
    const b: Lens<Both> = { id: "b", names, knobs: ["backlog", "rtt"], lanes: () => [lane("b")] };
    const controls = controlsOf([a, b]);
    expect(controls.get("a")).toEqual(["rtt", "hz"]);
    expect(controls.get("b")).toEqual(["backlog"]);
    expect(lanesOf([a, b], { rtt: 1, hz: 250, backlog: 4096 }).map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("computes a memo once for one settings object, and again for a new one", () => {
    let count = 0;
    const model = memo((settings: { readonly n: number }) => {
      count += 1;
      return settings.n * 2;
    });
    const one = { n: 2 };
    expect(model(one)).toBe(4);
    expect(model(one)).toBe(4);
    expect(count).toBe(1);
    expect(model({ n: 2 })).toBe(4);
    expect(count).toBe(2);
  });

  it("gives a band in seconds, and one point for one time", () => {
    const band = bandOf(quantity(1500, "ms"));
    expect(band.low).toEqual(quantity(1.5, "s"));
    expect(band.high).toEqual(band.low);
  });
});

describe("the five lenses of the path", () => {
  it("are the lanes of the path, from the program down to the NIC", () => {
    expect(LENSES.map((lens) => lens.id)).toEqual(["process", "socket", "tcp", "kube", "nic"]);
    for (const preset of PRESETS) {
      expect(requestPath(preset.settings).layers).toEqual(lanesOf(LENSES, preset.settings));
    }
  });

  it("name each knob of the path once, and only knobs of the settings", () => {
    const named = LENSES.flatMap((lens) => lens.knobs);
    expect(new Set(named).size).toBe(named.length);
    for (const knob of named) expect(Object.keys(DEFAULTS)).toContain(knob);
    // the fault, the request and the heal belong to the page, not to one lens. The cap of the backoff keeps its default: the page has no control for it
    const page: ReadonlyArray<keyof Settings> = ["fault", "inFlight", "heal", "backoffCap"];
    expect([...named, ...page].sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it("give the same lane for equal settings in a new object", () => {
    const tcp = lensOf("tcp");
    expect(tcp.lanes({ ...DEFAULTS })).toEqual(tcp.lanes(DEFAULTS));
  });
});
