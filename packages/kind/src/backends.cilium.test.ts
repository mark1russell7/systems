import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backendsOf, ciliumBackendsOf, namesService } from "./backends.ts";

// Real replies of `GET /v1/service` of the agent of Cilium 1.20.4 on a worker, from the job
// `capture` of kind.yml (src/cilium.capture.test.ts). The Deployment `cap/server` has two
// replicas. Each deletion makes a new pod, and the new pod is not ready: its state is `maintenance`.
const dump = (state: string): string => readFileSync(new URL(`../test/cilium/${state}.json`, import.meta.url), "utf8");
const RULE = JSON.parse(dump("rule")) as { ns: string; svc: string; ip: string; port: number };

describe("the backends of a Service in the reply of the agent of Cilium", () => {
  it("gives the two active backends when the two pods are ready", () => {
    expect(backendsOf("cilium", dump("ready"), RULE)).toEqual(["10.244.1.64:6379", "10.244.2.90:6379"]);
  });

  it("gives only the active backend when one pod stops, and not the new pod in maintenance", () => {
    expect(ciliumBackendsOf(dump("one-terminating"), RULE)).toEqual(["10.244.2.90:6379"]);
  });

  it("gives the terminating backends when no backend is active", () => {
    expect(ciliumBackendsOf(dump("all-terminating"), RULE)).toEqual(["10.244.1.64:6379", "10.244.2.90:6379"]);
  });

  it("matches the frontend by its address, its port and its protocol", () => {
    const reply = dump("ready");
    expect(ciliumBackendsOf(reply, { ip: RULE.ip, port: 81 })).toEqual([]);
    // kube-dns has a TCP and a UDP frontend on 53, and only the TCP one counts
    const services = JSON.parse(reply) as Array<{ spec: { "frontend-address": { ip: string; protocol: string }; flags: { name: string } } }>;
    const dns = services.filter((each) => each.spec.flags.name === "kube-dns" && each.spec["frontend-address"].ip === "10.96.0.10");
    expect(new Set(dns.map((each) => each.spec["frontend-address"].protocol))).toEqual(new Set(["TCP", "UDP"]));
    expect(ciliumBackendsOf(reply, { ip: "10.96.0.10", port: 53 })).toHaveLength(2);
  });

  it("tells if the reply names the Service, and refuses a reply that is not a list", () => {
    expect(namesService("cilium", dump("ready"), RULE)).toBe(true);
    expect(namesService("cilium", dump("ready"), { ns: RULE.ns, svc: "other" })).toBe(false);
    expect(namesService("cilium", "curl: (7) Failed to connect", RULE)).toBe(false);
    expect(() => ciliumBackendsOf("{}", RULE)).toThrow(/not a list/);
  });
});
