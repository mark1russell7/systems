import { CLOUDS, LAYERS, substrateOn } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { cellOf } from "./cells.fixture.ts";
import { FORMAT } from "./record.ts";
import { scenario } from "./scenario.ts";
import { kindCellRecordSchema, substrateSchema } from "./schema.ts";

const HOST = { vendor: "Microsoft Corporation", kernel: "6.11.0-1018-azure", hz: 1000, kvm: true, image: "ubuntu24/20261018.1" };
const CLUSTER = { kind: "0.31.0", nodeImage: "kindest/node:v1.37.0", server: "v1.37.0", mode: "iptables", docker: "28.5.0", nodes: [] };

describe("the record schema of kind", () => {
  it("keeps the substrate of a manifest and the zones of its scenario", () => {
    const substrate = substrateOn("E2", HOST);
    const manifest = { env: 0, scenario: scenario("c-1", "iptables", 3, undefined, true), cluster: CLUSTER, images: {}, substrate };
    const verdict = { decision: "void", counted: 0, voided: 0, failed: 0, median: null, why: "a test", checks: [] };
    const record = { format: FORMAT, cell: cellOf("zone-loss"), runs: [], manifests: [manifest], loads: [], at: "2026-11-08T00:00:00.000Z", verdict };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.manifests[0]?.substrate).toEqual(substrate);
    expect(parsed.data.manifests[0]?.scenario.zoned).toBe(true);
  });

  it("reads a manifest from before the substrate, and a scenario without zones", () => {
    const manifest = { env: 0, scenario: scenario("c-1", "iptables", 3), cluster: CLUSTER, images: {} };
    const verdict = { decision: "void", counted: 0, voided: 0, failed: 0, median: null, why: "a test", checks: [] };
    const record = { format: FORMAT, cell: cellOf("crash"), runs: [], manifests: [manifest], loads: [], at: "2026-11-08T00:00:00.000Z", verdict };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.manifests[0]?.substrate).toBeUndefined();
    expect(parsed.data.manifests[0]?.scenario.zoned).toBeUndefined();
  });
});

describe("the substrate schema of kind", () => {
  it("accepts each layer and each cloud of the harness, and no other", () => {
    for (const layer of LAYERS) expect(substrateSchema.parse(substrateOn(layer, HOST)).layer).toBe(layer);
    for (const cloud of CLOUDS) expect(substrateSchema.parse({ ...substrateOn("E1", HOST), cloud }).cloud).toBe(cloud);
    expect(substrateSchema.safeParse({ ...substrateOn("E1", HOST), layer: "E7" }).success).toBe(false);
    expect(substrateSchema.safeParse({ ...substrateOn("E1", HOST), cloud: "gcp" }).success).toBe(false);
  });

  it("keeps each field of a substrate of the harness", () => {
    const substrate = substrateOn("E3", { vendor: null, kernel: null, hz: null, kvm: false, image: null });
    expect(substrateSchema.parse(substrate)).toEqual(substrate);
    expect(Object.keys(substrateSchema.parse(substrateOn("E2", HOST))).sort()).toEqual(Object.keys(substrateOn("E2", HOST)).sort());
  });
});
