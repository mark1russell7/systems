import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { KUBE_PROBE, cellOf } from "./cells.fixture.ts";
import { clientObjects, probeOf, serverObjects } from "./manifests.ts";

/** This function gives the container of the server of a cell. */
const containerOf = (cell: KindCell): Record<string, unknown> => {
  const [, deployment] = serverObjects(cell, "lab-ns", "grpc-go:test") as [unknown, { spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } }];
  return deployment.spec.template.spec.containers[0]!;
};

const grpc = (kind: Parameters<typeof cellOf>[0]): KindCell => ({ ...cellOf(kind), stack: "grpc", declaration: null });

describe("the manifests of the stack grpc", () => {
  it("gives a gRPC probe the service that it names, or no service", () => {
    expect(probeOf(null, KUBE_PROBE)).toMatchObject({ grpc: { port: 8080 } });
    expect(probeOf(null, KUBE_PROBE)["grpc"]).not.toHaveProperty("service");
    expect(probeOf(null, KUBE_PROBE, "liveness")).toMatchObject({ grpc: { port: 8080, service: "liveness" }, periodSeconds: 10, failureThreshold: 3 });
    expect(probeOf("/liveness", KUBE_PROBE)).toMatchObject({ httpGet: { path: "/liveness", port: 9000 } });
  });

  it("gives grpc-go the flag file of a liveness restart, and the liveness probe the service liveness", () => {
    const container = containerOf(grpc("liveness-restart"));
    expect(container["command"]).toEqual(["grpc-go-server", "--port", "8080", "--name", "$(POD_NAME)", "--clock", "ms", "--fail-file", "/tmp/lab-fail"]);
    expect(container["livenessProbe"]).toMatchObject({ grpc: { port: 8080, service: "liveness" } });
    // the flag file does not fail the readiness probe: a check of the service ""
    expect(container["readinessProbe"]).toMatchObject({ grpc: { port: 8080 } });
    expect((container["readinessProbe"] as { grpc: object }).grpc).not.toHaveProperty("service");
  });

  it("keeps grpc-go at its defaults for each other trigger", () => {
    for (const kind of ["pod-deletion", "rolling-update", "scale-in", "node-drain"] as const) {
      const container = containerOf(grpc(kind));
      expect(container["command"], kind).toEqual(["grpc-go-server", "--port", "8080", "--name", "$(POD_NAME)", "--clock", "ms"]);
      expect(container["livenessProbe"], kind).toMatchObject({ grpc: { port: 8080 } });
      expect((container["livenessProbe"] as { grpc: object }).grpc, kind).not.toHaveProperty("service");
    }
  });
});

describe("the manifests of cannot-serve", () => {
  type Env = Array<{ name: string; value?: string }>;
  const envOf = (objects: unknown[], index: number): Env =>
    (objects[index] as { spec: { template: { spec: { containers: Array<{ env: Env }> } } } }).spec.template.spec.containers[0]!.env;
  const configOf = (cell: KindCell): Record<string, unknown> =>
    JSON.parse(envOf(serverObjects(cell, "lab-ns", "lab:test"), 1).find((entry) => entry.name === "CONFIG")!.value!) as Record<string, unknown>;

  it("tells the app to fail its route at the flag, and gives the lame duck of the declaration", () => {
    const cell = cellOf("cannot-serve", { ...cellOf("cannot-serve").declaration!, lameDuck: false });
    expect(configOf(cell)).toMatchObject({ failsRoute: true, declaration: { lameDuck: false } });
    // each other trigger keeps its config as it was
    expect(configOf(cellOf("liveness-restart"))).not.toHaveProperty("failsRoute");
  });

  it("gives each client its count of keep-alive connections, or no count", () => {
    const keeps: KindCell = { ...cellOf("cannot-serve"), workload: { ...cellOf("cannot-serve").workload, connections: 8 } };
    expect(envOf(clientObjects(keeps, "lab-ns", "lab:test", "10.96.0.10:8080"), 0)).toContainEqual({ name: "CONNECTIONS", value: "8" });
    expect(envOf(clientObjects(cellOf("cannot-serve"), "lab-ns", "lab:test", "10.96.0.10:8080"), 0).map((entry) => entry.name)).not.toContain("CONNECTIONS");
  });

  it("tells each client to speak HTTP/2 only when the declaration has the protocol h2c, and the app gets the protocol in its config", () => {
    const base = cellOf("cannot-serve");
    const h2c: KindCell = { ...base, declaration: { ...base.declaration!, protocol: "h2c" }, workload: { ...base.workload, connections: 1 } };
    expect(envOf(clientObjects(h2c, "lab-ns", "lab:test", "10.96.0.10:8080"), 0)).toContainEqual({ name: "PROTOCOL", value: "h2c" });
    expect(configOf(h2c)).toMatchObject({ declaration: { protocol: "h2c" } });
    expect(envOf(clientObjects(base, "lab-ns", "lab:test", "10.96.0.10:8080"), 0).map((entry) => entry.name)).not.toContain("PROTOCOL");
    const plain: KindCell = { ...base, declaration: { ...base.declaration!, protocol: "http/1.1" } };
    expect(envOf(clientObjects(plain, "lab-ns", "lab:test", "10.96.0.10:8080"), 0).map((entry) => entry.name)).not.toContain("PROTOCOL");
  });

  it("gives each client the knobs of its session check as JSON, or no variable", () => {
    const base = cellOf("cannot-serve");
    const sessionCheck = { keepalive_time: { value: 500, unit: "ms" }, keepalive_timeout: { value: 500, unit: "ms" } } as const;
    const checked: KindCell = { ...base, declaration: { ...base.declaration!, protocol: "h2c" }, workload: { ...base.workload, connections: 1, sessionCheck } };
    const env = envOf(clientObjects(checked, "lab-ns", "lab:test", "10.96.0.10:8080"), 0);
    expect(JSON.parse(env.find((entry) => entry.name === "SESSION_CHECK")!.value!)).toEqual(sessionCheck);
    expect(envOf(clientObjects(base, "lab-ns", "lab:test", "10.96.0.10:8080"), 0).map((entry) => entry.name)).not.toContain("SESSION_CHECK");
  });
});
