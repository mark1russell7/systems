import { describe, expect, it } from "vitest";
import type { Fabric, RunRoute } from "./cell.ts";
import { DAEMONS, FRR_IMAGE, ROUTERS, frrConf, laterMove, leafLacks, monotonicAt, routeLine, sessionsOf, topologyOf } from "./fabric.ts";

const BGP: Fabric = { keepalive: { value: 2, unit: "s" }, hold: { value: 6, unit: "s" }, bfd: null };
const BFD: Fabric = { ...BGP, bfd: { interval: { value: 240, unit: "ms" }, multiplier: 3 } };

const router = (name: string) => {
  const found = ROUTERS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no router ${name}`);
  return found;
};

describe("the plan of a fabric", () => {
  it("gives each interface of a link one side of one /31", () => {
    const addresses = ROUTERS.flatMap((each) => Object.values(each.interfaces));
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const each of ROUTERS)
      for (const neighbor of each.neighbors)
        expect(ROUTERS.find((other) => Object.values(other.interfaces).includes(`${neighbor.address}/31`))?.as).toBe(neighbor.as);
  });

  it("makes each leaf prefer spine1, on the device that a silence takes away", () => {
    for (const name of ["leaf1", "leaf2"]) {
      const leaf = router(name);
      const preferred = leaf.neighbors.find((neighbor) => neighbor.weight === 100);
      expect(preferred?.as).toBe(65101);
      expect(preferred?.address.split(".").slice(0, 3)).toEqual(leaf.interfaces["eth1"]!.split(".").slice(0, 3));
    }
  });

  it("gives a router the timers of the cell, with graceful restart off", () => {
    const conf = frrConf(router("leaf1"), BGP);
    expect(conf).toContain(" neighbor 10.0.1.1 timers 2 6\n");
    expect(conf).toContain(" neighbor 10.0.1.1 timers connect 1\n");
    expect(conf).toContain(" neighbor 10.0.1.1 advertisement-interval 0\n");
    expect(conf).toContain(" bgp graceful-restart-disable\n");
    expect(conf).toContain("  neighbor 10.0.1.1 weight 100\n");
    expect(conf).toContain("  maximum-paths 1\n");
    expect(conf).toContain("  network 10.1.0.0/24\n");
    expect(conf).not.toContain("bfd");
  });

  it("gives BFD to each neighbor of each router only when the fabric has it", () => {
    for (const each of ROUTERS) {
      const conf = frrConf(each, BFD);
      expect(conf).toContain("  receive-interval 240\n");
      expect(conf).toContain("  transmit-interval 240\n");
      expect(conf).toContain("  detect-multiplier 3\n");
      for (const neighbor of each.neighbors) expect(conf).toContain(` neighbor ${neighbor.address} bfd profile fast\n`);
    }
  });

  it("starts only the daemons that the fabric needs", () => {
    expect(DAEMONS).toContain("bgpd=yes\n");
    expect(DAEMONS).toContain("bfdd=yes\n");
    expect(DAEMONS).not.toContain("ospfd");
  });

  it("gives containerlab the pinned image, the MTU of Docker and a management network of the lab", () => {
    const yaml = topologyOf("e3-1", "/tmp/fabric", "brave_client", "calm_target");
    expect(yaml.split("\n").filter((line) => line === `      image: ${FRR_IMAGE}`)).toHaveLength(4);
    expect(yaml).toContain('    - endpoints: ["leaf1:eth3", "brave_client:eth1"]\n      mtu: 1500\n');
    expect(yaml).toContain('    - endpoints: ["leaf2:eth3", "calm_target:eth1"]\n      mtu: 1500\n');
    expect(yaml.split("\n").filter((line) => line === "      mtu: 1500")).toHaveLength(6);
    expect(yaml).toContain("mgmt:\n  network: clab-e3-1\n  ipv4-subnet: auto\n");
    expect(yaml).toContain("    brave_client:\n      kind: ext-container\n");
  });
});

describe("the lines of a route monitor", () => {
  it("reads a new route on the UTC clock of a container", () => {
    expect(routeLine("[2026-11-04T16:20:00.123456] 10.2.0.0/24 nhid 33 via 10.0.2.1 dev eth2 proto bgp metric 20 ")).toEqual({
      wall: Date.UTC(2026, 10, 4, 16, 20, 0) + 123.456,
      deleted: false,
      prefix: "10.2.0.0/24",
      via: "10.0.2.1",
      dev: "eth2",
    });
  });

  it("tells a deleted route from a replaced one", () => {
    expect(routeLine("[2026-11-04T16:20:00.000001] Deleted 10.2.0.0/24 nhid 33 via 10.0.1.1 dev eth1 proto bgp metric 20")?.deleted).toBe(true);
    const replaced = routeLine("[2026-11-04T16:20:00.000001] Replaced 10.2.0.0/24 nhid 34 via 10.0.2.1 dev eth2 proto bgp metric 20");
    expect(replaced?.deleted).toBe(false);
    expect(replaced?.prefix).toBe("10.2.0.0/24");
  });

  it("reads a route that the kernel prints as a next hop", () => {
    expect(routeLine("[2026-11-04T16:20:00.000001] 10.2.0.0/24 proto bgp metric 20 nexthop via 10.0.2.1 dev eth2 weight 1")?.dev).toBe("eth2");
  });

  it("gives null for another line", () => {
    expect(routeLine("Dump terminated")).toBeNull();
  });

  it("takes a wall time to the monotonic clock of the pair", () => {
    expect(monotonicAt(1_000.5, { mono: 5e9, wall: 1_000 })).toBe(5e9 + 5e5);
  });
});

const route = (leaf: string, t: number, prefix: string, dev: string, deleted = false): RunRoute => ({
  leaf,
  t,
  deleted,
  prefix,
  via: null,
  dev,
});

describe("the later move", () => {
  const far = { leaf1: "10.2.0.0/24", leaf2: "10.1.0.0/24" };

  it("takes the later of the first move of each leaf", () => {
    expect(
      laterMove(
        [route("leaf1", 10, far.leaf1, "eth2"), route("leaf2", 20, far.leaf2, "eth2"), route("leaf1", 30, far.leaf1, "eth1")],
        5,
      ),
    ).toBe(20);
  });

  it("gives null while one leaf has not moved", () => {
    expect(laterMove([route("leaf1", 10, far.leaf1, "eth2")], 5)).toBeNull();
  });

  it("does not count a line from before the fault, a deleted route, another prefix or a route on spine1", () => {
    expect(
      laterMove(
        [
          route("leaf1", 1, far.leaf1, "eth2"),
          route("leaf1", 6, far.leaf1, "eth2", true),
          route("leaf1", 7, "10.9.0.0/24", "eth2"),
          route("leaf1", 8, far.leaf1, "eth1"),
          route("leaf1", 9, far.leaf1, "eth2"),
          route("leaf2", 10, far.leaf2, "eth2"),
        ],
        5,
      ),
    ).toBe(10);
  });
});

describe("the state of a leaf", () => {
  const up = (established: number) => ({ bgpState: "Established", connectionsEstablished: established });
  const neighbors = JSON.stringify({ "10.0.1.1": up(1), "10.0.2.1": up(2) });
  const views = {
    neighbors,
    route: "10.2.0.0/24 nhid 33 via 10.0.1.1 dev eth1 proto bgp metric 20 ",
    paths: JSON.stringify({ paths: [{}, {}] }),
    bfd: null,
  };

  it("sums the sessions", () => {
    expect(sessionsOf(neighbors)).toEqual({ up: 2, established: 3 });
  });

  it("is ready with two sessions, the route on spine1 and the other path", () => {
    expect(leafLacks(views)).toBeNull();
  });

  it("names what it lacks", () => {
    expect(leafLacks({ ...views, neighbors: JSON.stringify({ "10.0.1.1": up(1), "10.0.2.1": { bgpState: "Connect" } }) })).toContain("1 of 2");
    expect(leafLacks({ ...views, route: "10.2.0.0/24 via 10.0.2.1 dev eth2 proto bgp " })).toContain("spine1");
    expect(leafLacks({ ...views, route: "" })).toContain("no route");
    expect(leafLacks({ ...views, paths: JSON.stringify({ paths: [{}] }) })).toContain("1 of 2 paths");
    expect(leafLacks({ ...views, paths: "{}" })).toContain("0 of 2 paths");
  });

  it("waits for each BFD peer of a fabric with BFD", () => {
    expect(leafLacks({ ...views, bfd: JSON.stringify([{ status: "up" }, { status: "down" }]) })).toContain("1 of 2 BFD");
    expect(leafLacks({ ...views, bfd: JSON.stringify([{ status: "up" }, { status: "up" }]) })).toBeNull();
  });
});
