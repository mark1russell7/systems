import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessImage } from "./image.ts";

/**
 * The build of the harness image on the kernel of the host, opt-in: `HARNESS_IMAGE=1`. It needs Docker.
 * The test argv of the VM tier (vm-run.yml) operates it in the guest (SYS-146). The build operates the
 * tests of the native code of the image, thus a change of the guest kernel or of that code that breaks
 * the image fails the pull request. In a guest, the tag goes to the output of the run, and the workflow
 * reads it there. Thus a skipped test does not pass the gate.
 */
const RUN = process.env["HARNESS_IMAGE"] === "1";

describe.skipIf(!RUN)("the harness image on the kernel of the host (HARNESS_IMAGE=1)", () => {
  it("builds, and the tests of its native code pass", async () => {
    const tag = await harnessImage();
    expect(tag).toMatch(/^loom-harness:[0-9a-f]{12}$/);
    const out = process.env["VM_OUT"];
    if (out !== undefined) writeFileSync(join(out, "harness-image"), `${tag}\n`);
  }, 30 * 60_000);
});
