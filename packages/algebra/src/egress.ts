/**
 * These functions give the law of the egress queue of a Linux device. They cover the rate of netem,
 * the token bucket of tbf and the limits of the FIFO qdiscs. The sources are Linux v7.0. Each length is the
 * length that the qdisc counts, in bytes. Each time is in nanoseconds, and each rate is in bytes per
 * second.
 *
 * - The qdisc length of a packet is `skb->len`, with the link header (`qdisc_pkt_len_segs_init`,
 *   `net/core/dev.c`, line 4111). A GSO packet adds the headers of each segment after the first one
 *   (line 4158).
 * - netem gives each packet a time to send (`net/sched/sch_netem.c`, lines 565-603). It takes the
 *   later of two times: the time to send of the last packet in its queue, and the arrival plus the
 *   delay. Then it adds the time of the packet at the rate. The time of a packet adds the overhead and rounds the
 *   length up to whole cells (lines 357-370).
 * - netem drops a packet when its queue holds `limit` packets (line 527). A packet stays in that queue
 *   until its time to send (lines 726-728), thus the limit also counts the packets of the delay.
 * - tbf keeps its tokens as time (`net/sched/sch_tbf.c`, lines 276-318). A packet leaves when the
 *   tokens of the rate, and of the peak rate when there is one, cover its time. The time of a length
 *   is `len × mult >> shift` (`include/net/sch_generic.h`, lines 1377-1389), with the `mult` and the
 *   `shift` of `net/sched/sch_generic.c`, lines 1493-1510.
 * - tbf drops a packet longer than its largest size (line 253). Its child bfifo drops a packet that
 *   puts the bytes of its queue above the limit (`net/sched/sch_fifo.c`, lines 19-27).
 *
 * The model takes each timer at its due time. A late timer delays the dequeue, but the next time to
 * send and the next tokens come from the due times. Thus a late timer does not slow the rate.
 */

const NSEC_PER_SEC = 1_000_000_000n;

const count = (value: number, what: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is not a count: ${value}`);
  return BigInt(value);
};

const signed = (value: number, what: string): bigint => {
  if (!Number.isSafeInteger(value)) throw new Error(`${what} is not an integer: ${value}`);
  return BigInt(value);
};

const positive = (value: number, what: string): bigint => {
  const result = count(value, what);
  if (result === 0n) throw new Error(`${what} is 0`);
  return result;
};

const safe = (value: bigint, what: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${what} is not a safe count: ${value}`);
  return result;
};

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/**
 * This function gives the qdisc length of one UDP datagram of `payload` bytes on an Ethernet device
 * or a veth. It adds the Ethernet header of 14 bytes, the IP header and the UDP header of 8 bytes. The
 * IP header is 20 bytes for IPv4 and 40 bytes for IPv6, with no options.
 */
export const udpFrameLength = (payload: number, family: 4 | 6 = 4): number =>
  safe(count(payload, "the payload") + 14n + (family === 6 ? 40n : 20n) + 8n, "the length");

/**
 * This function gives the qdisc length of a GSO packet of `length` bytes in `segments` segments. Each
 * segment after the first adds `headers` bytes: the link, network and transport headers of one
 * segment (`net/core/dev.c`, lines 4119-4158).
 */
export const gsoQdiscLength = (length: number, segments: number, headers: number): number => {
  const segs = positive(segments, "the count of segments");
  return safe(count(length, "the length") + (segs - 1n) * count(headers, "the headers"), "the length");
};

/** This record is the rate of netem: `tc qdisc ... netem rate <rate> [overhead] [cellsize] [celloverhead]`. */
export interface NetemRate {
  /** This value is the rate in bytes per second. */
  readonly rate: number;
  /** This value is the overhead that netem adds to each length. It can be negative. */
  readonly packetOverhead?: number;
  /** This value is the size of one cell. With 0, netem counts no cells. */
  readonly cellSize?: number;
  /** This value is the overhead of each cell. It can be negative. */
  readonly cellOverhead?: number;
}

const netemTime = (length: bigint, rate: NetemRate): bigint => {
  const speed = positive(rate.rate, "the rate");
  let len = length + signed(rate.packetOverhead ?? 0, "the packet overhead");
  if (len < 0n) throw new Error(`the length with the overhead is negative: ${len}`);
  const cell = count(rate.cellSize ?? 0, "the cell size");
  if (cell > 0n) {
    const cells = ceilDiv(len, cell);
    len = cells * (cell + signed(rate.cellOverhead ?? 0, "the cell overhead"));
    if (len < 0n) throw new Error(`the length in cells is negative: ${len}`);
  }
  return (len * NSEC_PER_SEC) / speed;
};

/**
 * This function gives the time that netem gives a packet of `length` bytes at its rate, in
 * nanoseconds (`packet_time_ns`, lines 357-370). It rounds down. A packet of 1,514 bytes at 10 Mbit/s
 * (1,250,000 bytes per second) takes 1,211,200 ns.
 */
export const netemPacketTime = (length: number, rate: NetemRate): number =>
  safe(netemTime(count(length, "the length"), rate), "the time");

/** This record is one packet that comes to an egress queue. */
export interface EgressPacket {
  /** This value is the time of the arrival, in nanoseconds. The arrivals of a schedule do not go back in time. */
  readonly at: number;
  /** This value is the qdisc length of the packet, in bytes. */
  readonly length: number;
}

/** This record is what an egress queue does with one packet. */
export type EgressOutcome =
  | {
      readonly kind: "sent";
      /** This value is the time that the packet leaves the qdisc, in nanoseconds. */
      readonly at: number;
      /** This value is the packets in the queue at the arrival of the packet. */
      readonly ahead: number;
      /** This value is the bytes in the queue at the arrival of the packet. */
      readonly bytes: number;
    }
  | {
      readonly kind: "dropped";
      /** A `limit` drop is a full queue. A `size` drop is a packet longer than the largest size of tbf. */
      readonly why: "limit" | "size";
      readonly ahead: number;
      readonly bytes: number;
    };

/** This record is a netem qdisc with a rate: `tc qdisc ... netem [delay <latency>] limit <limit> rate <rate>`. */
export interface NetemQueue extends NetemRate {
  /** This value is the delay of each packet, in nanoseconds, with no jitter. */
  readonly latency?: number;
  /** This value is the most packets that the queue of netem holds. */
  readonly limit: number;
}

/** This record is the packets that a queue holds: the time that each one leaves, and its length. */
interface Held {
  readonly leaves: bigint;
  readonly length: bigint;
}

/** This function takes out the packets that left the queue at or before `time`. A packet that leaves at `time` counts as gone. */
const drain = (held: Held[], time: bigint): void => {
  let gone = 0;
  while (gone < held.length && held[gone]!.leaves <= time) gone += 1;
  held.splice(0, gone);
};

const sumOf = (held: readonly Held[]): bigint => held.reduce((sum, packet) => sum + packet.length, 0n);

const arrivalsOf = (packets: readonly EgressPacket[]): { at: bigint; length: bigint }[] => {
  let last = -1n;
  return packets.map((packet) => {
    const at = count(packet.at, "the arrival");
    if (at < last) throw new Error(`an arrival goes back in time: ${at} after ${last}`);
    last = at;
    return { at, length: count(packet.length, "the length") };
  });
};

/**
 * This function gives the outcome of each packet in a netem queue with a rate. A packet that the
 * queue takes leaves at `max(last, at + latency) + time`. `last` is the time to send of the packet
 * before it, and `time` is the time of `netemPacketTime`. The queue holds each packet until it
 * leaves, thus a delay of 100 ms at 1,000 packets per second fills a limit of 100.
 */
export const netemSchedule = (packets: readonly EgressPacket[], queue: NetemQueue): readonly EgressOutcome[] => {
  const limit = count(queue.limit, "the limit");
  const latency = count(queue.latency ?? 0, "the latency");
  const held: Held[] = [];
  let last: bigint | undefined;
  return arrivalsOf(packets).map(({ at, length }): EgressOutcome => {
    drain(held, at);
    const ahead = held.length;
    const bytes = safe(sumOf(held), "the bytes");
    if (BigInt(ahead) >= limit) return { kind: "dropped", why: "limit", ahead, bytes };
    const start = last !== undefined && last > at + latency ? last : at + latency;
    const leaves = start + netemTime(length, queue);
    held.push({ leaves, length });
    last = leaves;
    return { kind: "sent", at: safe(leaves, "the time to send"), ahead, bytes };
  });
};

/**
 * This record is a rate of the packet scheduler (`struct psched_ratecfg`): the rate of tbf, or its
 * peak rate.
 */
export interface PschedRate {
  /** This value is the rate in bytes per second. */
  readonly rate: number;
  /** This value is the overhead that the rate adds to each length. */
  readonly overhead?: number;
  /** This value is the least length that the rate counts. */
  readonly mpu?: number;
  /** An ATM link counts the length in cells of 48 bytes, and each cell takes 53 bytes. */
  readonly linklayer?: "ethernet" | "atm";
}

/** This record is the factor of a rate: `mult` and `shift` give `len × mult >> shift` nanoseconds. */
export interface PschedFactor {
  readonly mult: number;
  readonly shift: number;
}

const factorOf = (rate: bigint): { mult: bigint; shift: bigint } => {
  let factor = NSEC_PER_SEC;
  let shift = 0n;
  for (;;) {
    const mult = BigInt.asUintN(32, factor / rate);
    if (mult & (1n << 31n) || factor & (1n << 63n)) return { mult, shift };
    factor <<= 1n;
    shift += 1n;
  }
};

/**
 * This function gives the factor of a rate in bytes per second (`psched_ratecfg_precompute__`). The
 * kernel doubles a factor of 10^9 until the quotient by the rate fills 32 bits. At 125,000 bytes per
 * second, `mult` is 4,194,304,000 and `shift` is 19.
 */
export const pschedFactor = (rate: number): PschedFactor => {
  const { mult, shift } = factorOf(positive(rate, "the rate"));
  return { mult: Number(mult), shift: Number(shift) };
};

const pschedTime = (length: bigint, rate: PschedRate): bigint => {
  const { mult, shift } = factorOf(positive(rate.rate, "the rate"));
  let len = BigInt.asUintN(32, length + count(rate.overhead ?? 0, "the overhead"));
  const mpu = count(rate.mpu ?? 0, "the mpu");
  if (len < mpu) len = mpu;
  if (rate.linklayer === "atm") len = ceilDiv(len, 48n) * 53n;
  return BigInt.asUintN(64, len * mult) >> shift;
};

/**
 * This function gives the time of `length` bytes at a rate of the packet scheduler, in nanoseconds
 * (`psched_l2t_ns`). The kernel multiplies by its factor and does not divide. Thus a time can be
 * 1 ns short: 1,500 bytes at 3,000,000 bytes per second give 499,999 ns, not 500,000.
 */
export const pschedLengthTime = (length: number, rate: PschedRate): number =>
  safe(pschedTime(count(length, "the length"), rate), "the time");

/** This record is a peak rate of tbf: `peakrate <rate> mtu <burst>`. */
export interface TbfPeak extends PschedRate {
  /** This value is the depth of the bucket of the peak rate, in bytes (`TCA_TBF_PBURST`). */
  readonly burst: number;
}

/**
 * This record is a tbf qdisc. `burst` is the depth of the bucket in bytes, as the netlink attribute
 * `TCA_TBF_BURST` gives it (`net/sched/sch_tbf.c`, lines 399-401). `limit` is the bytes of the queue
 * of its child bfifo (lines 438-452).
 */
export interface TbfQueue {
  readonly rate: PschedRate;
  readonly burst: number;
  readonly limit: number;
  readonly peak?: TbfPeak;
}

/** This record is the parameters that tbf computes from its configuration (lines 392-436). */
export interface TbfBuckets {
  /** This value is the depth of the bucket of the rate, in nanoseconds. */
  readonly buffer: number;
  /** This value is the depth of the bucket of the peak rate, in nanoseconds, or 0 with no peak rate. */
  readonly mtu: number;
  /** This value is the largest qdisc length that tbf takes, in bytes. */
  readonly maxSize: number;
}

const bucketsOf = (queue: TbfQueue): { buffer: bigint; mtu: bigint; maxSize: bigint } => {
  const burst = positive(queue.burst, "the burst");
  const buffer = pschedTime(burst, queue.rate);
  if (!queue.peak) return { buffer, mtu: 0n, maxSize: burst };
  if (count(queue.peak.rate, "the peak rate") <= count(queue.rate.rate, "the rate"))
    throw new Error("the peak rate is not above the rate (line 410)");
  const pburst = positive(queue.peak.burst, "the burst of the peak rate");
  return { buffer, mtu: pschedTime(pburst, queue.peak), maxSize: burst < pburst ? burst : pburst };
};

/** This function gives the depths of the buckets of a tbf qdisc and its largest packet. */
export const tbfBuckets = (queue: TbfQueue): TbfBuckets => {
  const { buffer, mtu, maxSize } = bucketsOf(queue);
  return { buffer: safe(buffer, "the buffer"), mtu: safe(mtu, "the mtu"), maxSize: safe(maxSize, "the largest size") };
};

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * This function gives the outcome of each packet in a tbf qdisc. The buckets are full at the first
 * arrival. A packet leaves at the first time after its arrival and after the packet before it, when
 * the tokens of each bucket cover its time. After it leaves, each bucket loses its time. A bucket
 * gains one token for each nanosecond, up to its depth.
 *
 * Take a rate of 1 Mbit/s (125,000 bytes per second) and a burst of 3,000 bytes. Ten packets of
 * 1,000 bytes come at once. The first three leave at once, and each next one 8 ms after the one
 * before it.
 */
export const tbfSchedule = (packets: readonly EgressPacket[], queue: TbfQueue): readonly EgressOutcome[] => {
  const { buffer, mtu, maxSize } = bucketsOf(queue);
  const limit = count(queue.limit, "the limit");
  const held: Held[] = [];
  const arrivals = arrivalsOf(packets);
  let checkpoint = arrivals[0]?.at ?? 0n;
  let tokens = buffer;
  let peakTokens = mtu;
  return arrivals.map(({ at, length }): EgressOutcome => {
    drain(held, at);
    const ahead = held.length;
    const queued = sumOf(held);
    const bytes = safe(queued, "the bytes");
    if (length > maxSize) return { kind: "dropped", why: "size", ahead, bytes };
    if (queued + length > limit) return { kind: "dropped", why: "limit", ahead, bytes };
    const cost = pschedTime(length, queue.rate);
    const peakCost = queue.peak ? pschedTime(length, queue.peak) : 0n;
    const ready = max(at, checkpoint) - checkpoint;
    const wait = max(ready, max(cost - tokens, peakCost - peakTokens));
    const leaves = checkpoint + wait;
    tokens = min(buffer, tokens + wait) - cost;
    peakTokens = queue.peak ? min(mtu, peakTokens + wait) - peakCost : 0n;
    checkpoint = leaves;
    held.push({ leaves, length });
    return { kind: "sent", at: safe(leaves, "the time to send"), ahead, bytes };
  });
};

/**
 * This function gives the limit of a pfifo or a bfifo with no limit of its own (`net/sched/sch_fifo.c`,
 * lines 106-112). A pfifo holds `txqueuelen` packets. A bfifo holds `txqueuelen` times the MTU plus the
 * link header, in bytes (`psched_mtu`, `include/net/pkt_sched.h`, lines 131-134). A pfifo drops a
 * packet when it holds its limit. A bfifo drops a packet that puts its bytes above its limit (lines
 * 19-36).
 */
export const fifoDefaultLimit = (
  kind: "pfifo" | "bfifo",
  txQueueLen: number,
  mtu: number,
  hardHeaderLen = 14,
): number => {
  const packets = count(txQueueLen, "txqueuelen");
  if (kind === "pfifo") return safe(packets, "the limit");
  return safe(BigInt.asUintN(32, packets * (count(mtu, "the MTU") + count(hardHeaderLen, "the link header"))), "the limit");
};
