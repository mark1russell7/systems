import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, environmentOf } from "./environments.ts";

describe("the environments that stage 0 calibrated", () => {
  it("gives the runner image its δ_abs, and an image that stage 0 did not calibrate nothing", () => {
    expect(environmentOf({ ImageOS: "ubuntu24", ImageVersion: "20261012.334.1" })).toEqual(
      ENVIRONMENTS["ubuntu24 20261012.334.1"],
    );
    expect(environmentOf({ ImageOS: "ubuntu24", ImageVersion: "20261012.334.1" })?.noise).toEqual({ value: 1, unit: "ms" });
    // stage 0 of 2026-10-24: the worst of 90 resets took 0.316 ms, under the jiffy, and the cap stays 4
    expect(environmentOf({ ImageOS: "ubuntu24", ImageVersion: "20261023.334.3" })).toEqual({
      noise: { value: 1, unit: "ms" },
      cap: 4,
      run: 40129876394,
    });
    expect(environmentOf({ ImageOS: "ubuntu26", ImageVersion: "20261019.1.1" })).toBeUndefined();
    expect(environmentOf({})).toBeUndefined();
  });
});
