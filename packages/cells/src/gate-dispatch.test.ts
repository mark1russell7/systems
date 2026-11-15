import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The queue of the template merges main into each pull request that is behind it. Then it dispatches
 * each workflow of a check of the ruleset on the branch, with no inputs (SYS-118). Such a dispatch is
 * the gate of a pull request. It must not start a catalog: a run of each cell takes hours on many runners.
 */
const read = (name: string): string =>
  readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const cells = read("cells.yml");
const kind = read("kind.yml");

/** The default of an input of workflow_dispatch, or undefined when the workflow has no such input. */
const defaultOf = (workflow: string, input: string): string | undefined =>
  new RegExp(`\\n {6}${input}:\\n {8}description: [^\\n]*\\n {8}default: "([^"]*)"`).exec(workflow)?.[1];

/** A dispatch of Cells that names its cells. */
const NAMES_CELLS = "(inputs.only != '' || inputs.selection != '' || inputs.pair != '' || inputs.file != '')";
/** A dispatch of Cells that names no cells: the gate of a pull request. */
const GATE_CELLS =
  "(github.event_name == 'workflow_dispatch' && inputs.only == '' && inputs.selection == '' && inputs.pair == '' && inputs.file == '')";
/** A pull request, or a dispatch of Kind with no only: both get the smoke. */
const GATE_KIND = "(github.event_name != 'workflow_dispatch' || inputs.only == '')";

describe("the workflow Cells, on a dispatch with no inputs", () => {
  it("names no cells: each input that names cells is empty by default", () => {
    for (const input of ["only", "selection", "pair", "file"]) expect(defaultOf(cells, input)).toBe("");
  });

  it("runs the probe only: the plan and the cells start on a schedule or on a dispatch that names its cells", () => {
    const condition = `if: \${{ needs.changes.outputs.match == 'true' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && ${NAMES_CELLS})) }}`;
    expect(cells).toContain(`  plan:\n    needs: changes\n    ${condition}\n`);
    expect(cells).toContain(`  cells:\n    needs: [changes, probe, plan]\n    ${condition}\n`);
  });

  it("shares the cancel group of its branch with the other gate dispatches", () => {
    expect(cells).toContain(
      `  group: \${{ github.workflow }}-\${{ (github.event_name == 'pull_request' || ${GATE_CELLS}) && github.ref || github.run_id }}\n`,
    );
    expect(cells).toContain(`  cancel-in-progress: \${{ github.event_name == 'pull_request' || ${GATE_CELLS} }}\n`);
  });
});

describe("the workflow Kind, on a dispatch with no inputs", () => {
  it("names no cells: the default of only is empty", () => {
    expect(defaultOf(kind, "only")).toBe("");
  });

  it("runs the smoke of a pull request: one shard, 36 minutes, the calibration of each mode, 2 runs, one cluster", () => {
    for (const [name, smoke, input] of [
      ["SHARDS", "'1'", "shards"],
      ["MINUTES", "'36'", "minutes"],
      ["KIND_ONLY", "'^T07 (iptables|ipvs|nftables), the propagation'", "only"],
      ["KIND_RUNS", "'2'", "runs"],
      ["KIND_ENVIRONMENTS", "'1'", "environments"],
    ] as const) {
      expect(kind).toContain(`${name}: \${{ ${GATE_KIND} && ${smoke} || inputs.${input} }}\n`);
    }
    expect(kind).toContain(`timeout-minutes: \${{ fromJSON(${GATE_KIND} && '36' || inputs.minutes) }}\n`);
    // the old form gave the inputs of each dispatch, thus the defaults ran each cell of the catalogs
    expect(kind).not.toMatch(/github\.event_name == 'workflow_dispatch' && inputs\.(only|shards|minutes|runs|environments) \|\|/);
  });

  it("captures the services of Cilium, as a pull request does", () => {
    expect(kind).toContain("(github.event_name != 'workflow_dispatch' || inputs.only == '' || inputs.capture == 'true')");
  });

  it("shares the cancel group of its branch with the other gate dispatches", () => {
    const gate = "(github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.only == ''))";
    expect(kind).toContain(`  group: \${{ github.workflow }}-\${{ ${gate} && github.ref || github.run_id }}\n`);
    expect(kind).toContain("  cancel-in-progress: ${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.only == '') }}\n");
  });
});

describe("the labs HTTP and Process", () => {
  it("cancel an older dispatch of the same branch, and keep each run of a push to main", () => {
    for (const lab of ["http", "process"]) {
      const workflow = read(`${lab}.yml`);
      expect(workflow).toContain(`  group: ${lab}-\${{ github.event_name != 'push' && github.ref || github.sha }}\n`);
      expect(workflow).toContain("  cancel-in-progress: ${{ github.event_name != 'push' }}\n");
    }
  });
});
