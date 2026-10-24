import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { KUBE_PROBE, cellOf } from "./cells.fixture.ts";
import { probeOf, serverObjects } from "./manifests.ts";

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
