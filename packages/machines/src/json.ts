import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";
import { z } from "zod";
import ioredisStatus from "./ioredis-status.json" with { type: "json" };
import linuxTcp from "./linux-tcp.json" with { type: "json" };
import manifestations from "./manifestations.json" with { type: "json" };
import nfConntrackTcp from "./nf-conntrack-tcp.json" with { type: "json" };
import redisClient from "./redis-client.json" with { type: "json" };

// The documents of the kernel, of Redis and of ioredis are JSON files. The schema of the algebra
// examines each one at load, and a document that it refuses stops the import.

/** This document is TCP as Linux 6.6 implements it: one full socket, from the source of the kernel and the RFCs. */
export const LINUX_TCP: Machine = machineSchema.parse(linuxTcp);

/** This document is the TCP state machine of conntrack on Linux 6.6.87.2: the state of a router or a NAT for one flow. */
export const NF_CONNTRACK_TCP: Machine = machineSchema.parse(nfConntrackTcp);

/** This document is one client connection as the Redis 8.10.2 server holds it, over its Linux TCP socket. */
export const REDIS_CLIENT: Machine = machineSchema.parse(redisClient);

/** This document is the status of one standalone connection of ioredis 6.0.0, over its Linux TCP socket. */
export const IOREDIS_STATUS: Machine = machineSchema.parse(ioredisStatus);

/**
 * This map gives, for each manifestation of a failure, the incoming events that continue to arrive
 * at Linux TCP while the failure lasts. A black hole lets nothing through. The kernel of a frozen
 * process continues to send ACKs, thus `rx.ack` arrives.
 */
export const MANIFESTATIONS: Readonly<Record<string, readonly string[]>> = z
  .record(z.string(), z.array(z.string()))
  .parse(manifestations);
