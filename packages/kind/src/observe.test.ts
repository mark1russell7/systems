import { describe, expect, it } from "vitest";
import type { Line } from "./observe.ts";
import { byClients, intakeOf, signalOf, stoppingOf } from "./observe.ts";

describe("the target of a run of gRPC", () => {
  it("is the replica that answers the most clients, then the first by name", () => {
    const replicas = [{ pod: "lab-a" }, { pod: "lab-b" }, { pod: "lab-c" }];
    const answers = new Map([["client-1", "lab-b"], ["client-2", "lab-b"], ["client-3", "lab-c"]]);
    expect(byClients(replicas, answers).map((each) => each.pod)).toEqual(["lab-b", "lab-c", "lab-a"]);
    expect(byClients(replicas, new Map()).map((each) => each.pod)).toEqual(["lab-a", "lab-b", "lab-c"]);
  });
});

describe("the references of a server", () => {
  it("reads the intake and the SIGTERM of grpc-go from its line stopping", () => {
    const lines: Line[] = [
      { ev: "stopping", t: 500, p: "lab-b" },
      { ev: "accept", t: 900, p: "lab-a", local: "10.244.1.5:8080", remote: "10.244.2.3:40312" },
      { ev: "stopping", t: 1200.5, p: "lab-a" },
    ];
    expect(stoppingOf(lines, "lab-a", 0)).toBe(1200.5);
    expect(intakeOf(lines, "lab-a", 0)).toBe(1200.5);
    expect(signalOf(lines, "lab-a", 0)).toBe(1200.5);
    expect(intakeOf(lines, "lab-a", 1300)).toBeNull();
  });

  it("reads them from the records of the service, which have their own stamp", () => {
    const record = (t: number, at: number, m: string, to: string, on: string): Line => ({ ev: "rec", t, at, p: "lab-a", m, i: "lab", from: "serving", to, on, d: null });
    const lines = [record(1300, 1210, "drain", "stop intake", "phase"), record(1300, 1205, "exit", "exiting", "exit.request")];
    expect(intakeOf(lines, "lab-a", 0)).toBe(1210);
    expect(signalOf(lines, "lab-a", 0)).toBe(1205);
  });
});
