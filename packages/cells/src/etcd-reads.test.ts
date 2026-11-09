import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { etcdArgs, imageProblems, observeMsOf, unpinnedBases } from "@mark1russell7/harness";
import type { BuildImage, ClientImage } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { ETCD_CLUSTER, ETCD_KV, READ_CELLS, READ_SPECS, historyOf } from "./etcd-reads.ts";

describe("the read cells of etcd (SYS-75)", () => {
  it("gives each kind of read and each cut member one cell, with its verdict from the law", () => {
    expect(READ_CELLS.map((cell) => [cell.name.split(" ")[0], cell.probe.kv?.reads, cell.faultAt, cell.prediction.detects === null ? cell.prediction.history : undefined])).toEqual([
      ["LR.1", "linearizable", { role: "replica", cuts: "group" }, "Ok"],
      ["LR.2", "linearizable", { role: "primary", cuts: "group" }, "Ok"],
      ["LR.3", "serializable", { role: "replica", cuts: "group" }, "Illegal"],
      ["LR.4", "serializable", { role: "primary", cuts: "group" }, "Illegal"],
    ]);
    expect(READ_SPECS.map(historyOf)).toEqual(["Ok", "Ok", "Illegal", "Illegal"]);
  });

  it("is in the catalog once, and each cell is an etcd cell with the client of its history", () => {
    for (const cell of READ_CELLS) {
      expect(ALL.filter((each) => each.name === cell.name)).toHaveLength(1);
      expect(cell.etcd).toBe(ETCD_CLUSTER);
      expect(cell.client).toBe(ETCD_KV);
      expect(cell.fault).toBe("partition");
    }
  });

  it("observes the cut and the watch, and gives the client a deadline past the run", () => {
    const [cell] = READ_CELLS;
    expect(observeMsOf(cell!)).toBe(15_000);
    const args = etcdArgs(cell!, 1, 0);
    expect(args.slice(args.indexOf("--max-s"), args.indexOf("--max-s") + 2)).toEqual(["--max-s", "135"]);
    expect(args).toContain("linearizable");
  });

  it("builds the client from files that exist and bases pinned by digest, and each member is the etcd image of the harness", () => {
    const client = (ETCD_KV as ClientImage).image as BuildImage;
    expect(imageProblems(client)).toEqual([]);
    for (const file of client.files ?? []) expect(existsSync(join(client.context, file)), file).toBe(true);
    expect(unpinnedBases(readFileSync(join(client.context, client.dockerfile ?? "Dockerfile"), "utf8"))).toEqual([]);
    expect(ETCD_CLUSTER.image).toEqual({ kind: "shipped", name: "etcd" });
    expect(imageProblems(ETCD_CLUSTER.image)).toEqual([]);
  });
});
