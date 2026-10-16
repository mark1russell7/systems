import { describe, expect, it } from "vitest";
import type { Target } from "./cell.ts";
import { nodeClientImage, openLab } from "./lab.ts";

/**
 * A lab on Docker, opt-in: `HARNESS_LAB=1`. It needs Docker and privileged containers. It starts a
 * client from an image that the caller gives, and an agent in the namespaces of the target.
 */
const RUN = process.env["HARNESS_LAB"] === "1";
const REDIS: Target = {
  image: "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f",
  port: 6379,
  ready: "Ready to accept connections",
};

describe.skipIf(!RUN)("a lab on Docker (HARNESS_LAB=1)", () => {
  it("runs a client image in the namespace of the client, and an agent in the namespaces of the target", async () => {
    const node = await nodeClientImage();
    const lab = await openLab(REDIS, { image: node, command: ["node", "/opt/harness/node/client-ioredis.mjs"] });
    try {
      const probe = await lab.probe([lab.targetIp, String(lab.targetPort), "--mode", "idle", "--keepalive-ms", "5000", "--max-s", "5"]);
      const ready = await probe.until(["ready"], 15_000);
      expect(ready.ev).toBe("ready");
      // the prober saw the socket of the image in the namespace of the client
      const local = probe.events.find((event) => event.ev === "connected")?.["local"];
      await probe.stop();
      expect(lab.kernel.some((record) => record.netns === lab.netns.client && record.src === local)).toBe(true);
      expect((await lab.manifest({})).client).toEqual({ kind: "image", image: node });
      // an agent with the process namespace of the target finds the server process
      const agent = await lab.agent(node, ["sh", "-c", "while :; do sleep 3600; done"], { pid: true });
      expect(Number(await agent.exec(["sh", "-c", "pidof redis-server"]))).toBeGreaterThan(0);
      await agent.stop();
    } finally {
      await lab.close();
    }
  }, 300_000);
});
