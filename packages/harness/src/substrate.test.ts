import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Host } from "./substrate.ts";
import { cloudOf, comparable, readHost, substrateKey, substrateOf, substrateOn, unpoolable } from "./substrate.ts";

const AZURE: Host = { kernel: "7.0.0-1017-azure", hz: 1000, vendor: "Microsoft Corporation", kvm: true, image: "ubuntu24 20261101.360.1" };
const AWS: Host = { ...AZURE, vendor: "Amazon EC2" };

describe("the cloud of a host", () => {
  it("comes from the vendor, not from the name of the kernel", () => {
    expect(cloudOf("Microsoft Corporation")).toBe("azure");
    expect(cloudOf("Amazon EC2")).toBe("aws");
    // one image can start on each cloud, thus this kernel on AWS reads as AWS
    expect(substrateOn("E1", AWS).cloud).toBe("aws");
  });

  it("is unknown for another vendor, or with no vendor", () => {
    expect(cloudOf("QEMU")).toBe("unknown");
    expect(cloudOf(null)).toBe("unknown");
  });
});

describe("the host", () => {
  it("reads each fact from its file", () => {
    const root = mkdtempSync(join(tmpdir(), "substrate-"));
    try {
      mkdirSync(join(root, "sys/class/dmi/id"), { recursive: true });
      mkdirSync(join(root, "boot"));
      mkdirSync(join(root, "dev"));
      writeFileSync(join(root, "sys/class/dmi/id/sys_vendor"), "Amazon EC2\n");
      writeFileSync(join(root, "boot/config-7.0.0-test"), "CONFIG_HZ_1000=y\nCONFIG_HZ=1000\n");
      writeFileSync(join(root, "dev/kvm"), "");
      expect(readHost(root, { ImageOS: "ubuntu24", ImageVersion: "20261101.360.1" }, "7.0.0-test")).toEqual({
        kernel: "7.0.0-test",
        hz: 1000,
        vendor: "Amazon EC2",
        kvm: true,
        image: "ubuntu24 20261101.360.1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives null for a file that does not exist, and no KVM", () => {
    const root = mkdtempSync(join(tmpdir(), "substrate-"));
    try {
      expect(readHost(root, {}, "7.0.0-test")).toEqual({ kernel: "7.0.0-test", hz: null, vendor: null, kvm: false, image: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a record from before the block", () => {
  it("reads as the layer of its package, and nothing rewrites it", () => {
    const manifest = { kernel: "6.17.0-1010-azure", hz: "1000" };
    expect(substrateOf(manifest, "2026-10-16T10:00:00.000Z")).toEqual({
      layer: "E1",
      cloud: "azure",
      vendor: null,
      kernel: "6.17.0-1010-azure",
      hz: 1000,
      kvm: null,
      image: null,
    });
    expect(substrateOf(manifest, "2026-10-16T10:00:00.000Z", "E2").layer).toBe("E2");
    expect(manifest).toEqual({ kernel: "6.17.0-1010-azure", hz: "1000" });
  });

  it("has an unknown cloud from the day of the AWS change, whatever its kernel says", () => {
    expect(substrateOf({ kernel: "7.0.0-1017-azure" }, "2026-10-27T23:59:59.000Z").cloud).toBe("azure");
    expect(substrateOf({ kernel: "7.0.0-1017-azure" }, "2026-10-28T00:00:00.000Z").cloud).toBe("unknown");
  });

  it("keeps a block that the record holds", () => {
    const substrate = substrateOn("E1", AWS);
    expect(substrateOf({ substrate, kernel: "other" }, "2026-01-01T00:00:00.000Z")).toBe(substrate);
  });
});

describe("the comparison of two substrates", () => {
  it("holds for one layer, one kernel and one cloud", () => {
    expect(comparable(substrateOn("E1", AZURE), substrateOn("E1", AZURE))).toBe(true);
  });

  it("refuses two clouds, two kernels or two layers", () => {
    expect(comparable(substrateOn("E1", AZURE), substrateOn("E1", AWS))).toBe(false);
    expect(comparable(substrateOn("E1", AZURE), substrateOn("E1", { ...AZURE, kernel: "6.17.0-1010-azure" }))).toBe(false);
    expect(comparable(substrateOn("E1", AZURE), substrateOn("E2", AZURE))).toBe(false);
  });

  it("does not refuse an old record that cannot tell its cloud", () => {
    const old = substrateOf({ kernel: AZURE.kernel! }, "2026-11-01T00:00:00.000Z");
    expect(comparable(old, substrateOn("E1", AWS))).toBe(true);
    expect(comparable(old, substrateOn("E1", AZURE))).toBe(true);
  });

  it("finds the pair that cannot pool, past an old record that matches each", () => {
    const old = substrateOf({ kernel: AZURE.kernel! }, "2026-11-01T00:00:00.000Z");
    const azure = substrateOn("E1", AZURE);
    const aws = substrateOn("E1", AWS);
    expect(unpoolable([old, azure, aws])).toEqual([azure, aws]);
    expect(unpoolable([old, azure, azure])).toBeUndefined();
    expect(unpoolable([])).toBeUndefined();
  });

  it("has a one-line name", () => {
    expect(substrateKey(substrateOn("E1", AWS))).toBe("E1 aws 7.0.0-1017-azure");
    expect(substrateKey(substrateOf({}, "2026-11-01T00:00:00.000Z", "E2"))).toBe("E2 unknown unknown");
  });
});
