import type { Quantity } from "@mark1russell7/quantity";
import { quantity } from "@mark1russell7/quantity";

/**
 * An environment is a runner image that stage 0 calibrated: its δ_abs, its concurrency cap, and
 * the run that measured them. A cell that runs on it gets that δ_abs (`Cell.noise`). A cell on an
 * image that stage 0 did not calibrate keeps `NOISE` (4 ms), the value of the first environment.
 */
export interface Environment {
  readonly noise: Quantity;
  readonly cap: number;
  /** This number is the run of the cells workflow that measured stage 0 on the image. */
  readonly run: number;
}

/** These are the calibrated images, by `$ImageOS $ImageVersion` of the runner. */
export const ENVIRONMENTS: Readonly<Record<string, Environment>> = {
  // stage 0 on 2026-10-16: the worst reset took 0.147 ms, thus δ_abs is one jiffy at HZ 1000.
  // The noise of the scheduler reached that jiffy only at 8 environments, thus the cap is 4.
  "ubuntu24 20261012.334.1": { noise: quantity(1, "ms"), cap: 4, run: 38972428212 },
};

/** This function gives the environment of the runner from its image, or undefined for an image that stage 0 did not calibrate. */
export const environmentOf = (env: Readonly<Record<string, string | undefined>> = process.env): Environment | undefined =>
  ENVIRONMENTS[`${env["ImageOS"] ?? ""} ${env["ImageVersion"] ?? ""}`];
