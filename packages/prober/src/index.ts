// @mark1russell7/prober: the instrument that records what each layer did to a connection. Its
// first source is the kernel: bpf/prober.bpf.c, a libbpf CO-RE program, and the collector in
// native/ that prints each record as a JSON line. This module is the record contract for the
// readers of those lines.

import type { Quantity } from "@mark1russell7/quantity";

/** These are the kinds of record, in the sequence of the enum in `bpf/prober.h` and of `KINDS` in the Rust decoder. */
export const RECORD_KINDS = [
  "state",
  "accept",
  "retrans",
  "rst_tx",
  "rst_rx",
  "error",
  "destroy",
  "tw_enter",
  "tw_kill",
  "req_new",
  "rst_v4",
  "probe",
  "rx",
  "timer",
] as const;

/** A record kind is one kind of record that the kernel side writes. */
export type RecordKind = (typeof RECORD_KINDS)[number];

/** These are the lines of the collector itself: its start, its clock track, its failure, and a record that it cannot read. */
export type CollectorLine = "begin" | "clock" | "fail" | "undecodable";

/**
 * A kernel record is one record of the prober: what the kernel did to a socket. The eBPF side
 * stamps it on CLOCK_MONOTONIC, the clock that all containers on the VM share (`native/src/record.rs`).
 */
export interface KernelRecord {
  readonly ev: RecordKind | CollectorLine | string;
  readonly mono: number;
  readonly cookie?: number;
  readonly netns?: number;
  readonly src?: string;
  readonly dst?: string;
  readonly state?: number;
  /** This number is the `sk_err` of the socket at the time of the record: the errno of an error report. */
  readonly err?: number;
  /** This value is the cause of a retransmission: the tail loss probe, the RTO timer, or a fast retransmission from ACK processing. */
  readonly why?: "tlp" | "rto" | "fast";
  /** This value is the kind of a probe that `tcp_write_wakeup` sent, or of a socket timer that fired. */
  readonly what?: "keepalive" | "window" | "retransmit" | "other";
  /**
   * For a socket timer that fired, `behind` is the delay of the CPU after the slot of the timer
   * wheel. Only a stalled CPU causes that delay. `late` is the time after the expiry of the timer,
   * with the rounding of the wheel.
   */
  readonly behind?: Quantity;
  readonly late?: Quantity;
  /** This flag tells that a socket timer fired while the owner of the socket held it. Keepalive then tries again HZ/20 later. */
  readonly owned?: boolean;
  readonly tcp?: {
    readonly retransmits: number;
    readonly pending: number;
    readonly backoff: number;
    readonly probes_out: number;
    readonly rto: Quantity;
    readonly srtt: Quantity;
  };
  readonly seg?: { readonly seq: number; readonly ack?: number; readonly len: Quantity };
  readonly [field: string]: unknown;
}
