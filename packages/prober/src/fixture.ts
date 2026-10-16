/**
 * This module makes the records that all collectors decode to the same bytes
 * (`fixtures/records.bin`). It has each kind, and two kinds that the contract does not know. It has
 * each optional field present and absent, and the extremes of each integer. Its process names
 * test the JSON escapes and the lossy UTF-8 of Rust. A broken sequence becomes one U+FFFD for each
 * maximal prefix that cannot complete. The last record is cut short, and each collector reports it
 * as undecodable.
 *
 * The bytes are `struct ev` (`bpf/prober.h`), little-endian, as the kernel side writes it on x86.
 */

export const RECORD_SIZE = 216;

interface Fields {
  mono: bigint;
  tai: bigint;
  cookie: bigint;
  nscookie: bigint;
  cgid: bigint;
  skaddr: bigint;
  ino: bigint;
  kind: number;
  netns: number;
  saddr: readonly number[];
  daddr: readonly number[];
  extra: number;
  pid: number;
  fd: number;
  oldst: number;
  newst: number;
  state: number;
  err: number;
  owner: number;
  sport: number;
  dport: number;
  hasTcp: number;
  hasSeg: number;
  /**
   * These are the TCP fields: `retransmits`, `pending`, `backoff`, `probes_out`, `rto`, `srtt_us`,
   * `snd_una`, `snd_nxt` and `rcv_nxt`. Then come the SACK scoreboard and the reordering state:
   * `sacked_out`, `lost_out`, `reordering`, `reord_seen`, `dsack_dups` and `rcv_ooopack`.
   */
  tcp: readonly number[];
  /** These are the segment fields: `seq`, `ack`, `len` and `flags`. */
  seg: readonly number[];
  /** These are the jiffies of a timer after the slot of its wheel, and after its expiry. */
  behind: number;
  late: number;
  comm: readonly number[];
}

const BASE: Fields = {
  mono: 1_000_000_000n,
  tai: 1_760_000_000_000_000_000n,
  cookie: 4242n,
  nscookie: 7n,
  cgid: 9001n,
  skaddr: 0xffff_8880_1234_5678n,
  ino: 0n,
  kind: 1,
  netns: 4_026_532_000,
  saddr: [172, 21, 0, 3],
  daddr: [172, 21, 0, 2],
  extra: 0,
  pid: 100,
  fd: 7,
  oldst: 2,
  newst: 1,
  state: 1,
  err: 0,
  owner: 0,
  sport: 41_978,
  dport: 6379,
  hasTcp: 1,
  hasSeg: 1,
  tcp: [0, 1, 0, 0, 51, 120, 1000, 1064, 2000, 0, 0, 3, 0, 0, 0],
  seg: [1000, 2000, 64, 0x18],
  behind: 0,
  late: 0,
  comm: [...Buffer.from("client")],
};

const encode = (f: Fields): Uint8Array => {
  const bytes = new Uint8Array(RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u64 = (v: bigint) => (view.setBigUint64(at, v, true), (at += 8));
  const u32 = (v: number) => (view.setUint32(at, v, true), (at += 4));
  const i32 = (v: number) => (view.setInt32(at, v, true), (at += 4));
  const u16 = (v: number) => (view.setUint16(at, v, true), (at += 2));
  const raw = (v: readonly number[], length: number) => {
    bytes.set(v.slice(0, length), at);
    at += length;
  };
  for (const v of [f.mono, f.tai, f.cookie, f.nscookie, f.cgid, f.skaddr, f.ino]) u64(v);
  u32(f.kind);
  u32(f.netns);
  raw(f.saddr, 4);
  raw(f.daddr, 4);
  u32(f.extra);
  for (const v of [f.pid, f.fd, f.oldst, f.newst, f.state, f.err, f.owner]) i32(v);
  u16(f.sport);
  u16(f.dport);
  u32(f.hasTcp);
  u32(f.hasSeg);
  for (const v of f.tcp) u32(v);
  for (const v of f.seg) u32(v);
  u32(f.behind);
  u32(f.late);
  raw(f.comm, 16);
  if (at !== RECORD_SIZE) throw new Error(`struct ev laid out as ${at} bytes`);
  return bytes;
};

const bytesOf = (text: string): number[] => [...Buffer.from(text, "latin1")];
const U32 = 0xffff_ffff;
const U64 = 0xffff_ffff_ffff_ffffn;

/** These are the cases, each with the reason that it is in the fixture. */
export const CASES: ReadonlyArray<{ why: string; fields: Partial<Fields> }> = [
  { why: "a state change, owned, with TCP state", fields: { kind: 1, owner: 1 } },
  {
    why: "an accept, no CLOCK_TAI, no owner",
    fields: { kind: 2, tai: 0n, comm: bytesOf("redis-server") },
  },
  {
    why: "the tail loss probe",
    fields: { kind: 3, tcp: [0, 5, 0, 0, 51, 120, 1, 2, 3, 0, 0, 3, 0, 0, 0] },
  },
  {
    why: "the RTO timer's retransmission",
    fields: { kind: 3, tcp: [2, 0, 2, 0, 204, 120, 1, 2, 3, 0, 1, 3, 0, 0, 0] },
  },
  {
    why: "a retransmission from ACK processing, with SACKed segments",
    fields: { kind: 3, tcp: [0, 1, 0, 0, 51, 120, 1, 2, 3, 2, 0, 3, 0, 0, 0] },
  },
  { why: "a retransmission without TCP state names no cause", fields: { kind: 3, hasTcp: 0 } },
  { why: "an active reset", fields: { kind: 4, extra: 1, hasSeg: 0 } },
  { why: "a reset answering a segment", fields: { kind: 4, extra: 0, hasSeg: 0 } },
  { why: "a reset received", fields: { kind: 5 } },
  { why: "an error report", fields: { kind: 6, extra: 110, err: -110, hasTcp: 0, hasSeg: 0 } },
  { why: "a destruction", fields: { kind: 7, hasTcp: 0, hasSeg: 0 } },
  { why: "into TIME_WAIT", fields: { kind: 8, extra: 3, hasTcp: 0, hasSeg: 0 } },
  { why: "a TIME_WAIT socket killed", fields: { kind: 9, extra: 0, hasTcp: 0, hasSeg: 0 } },
  { why: "a request sock born", fields: { kind: 10, extra: 12, hasTcp: 0, hasSeg: 0 } },
  { why: "a reset from tcp_v4_send_reset", fields: { kind: 11, extra: 1, hasSeg: 0 } },
  { why: "a probe of no known kind", fields: { kind: 12, extra: 0, hasSeg: 0 } },
  { why: "a keepalive probe", fields: { kind: 12, extra: 1, hasSeg: 0 } },
  { why: "a zero-window probe", fields: { kind: 12, extra: 2, hasSeg: 0 } },
  { why: "a probe with a kind past the enum", fields: { kind: 12, extra: 9, hasSeg: 0 } },
  { why: "a segment received, with its ack and flags", fields: { kind: 13 } },
  { why: "a segment received with no segment recorded", fields: { kind: 13, hasSeg: 0 } },
  {
    why: "a segment received after reordering: the scoreboard, the DSACKs and the out-of-order count",
    fields: { kind: 13, tcp: [0, 1, 0, 0, 51, 120, 1000, 1064, 2000, 4, 1, 12, 2, 3, 17] },
  },
  {
    why: "a keepalive timer run on its slot, 8 jiffies past its expiry",
    fields: { kind: 14, extra: 1, hasSeg: 0, late: 8 },
  },
  {
    why: "a retransmit timer run 24 jiffies behind its slot",
    fields: { kind: 14, extra: 2, hasSeg: 0, behind: 24, late: 25 },
  },
  { why: "a timer of no known kind", fields: { kind: 14, extra: 7, hasSeg: 0 } },
  { why: "a write: its first sequence number and its length, no ack and no flags", fields: { kind: 15 } },
  {
    why: "a keepalive timer that found its socket in its owner's hands",
    fields: { kind: 14, extra: 0x101, hasSeg: 0, late: 4 },
  },
  {
    why: "a probe's extra with the owned bit means nothing to a probe",
    fields: { kind: 12, extra: 0x101, hasSeg: 0 },
  },
  { why: "a timer's counts on another kind say nothing", fields: { kind: 12, behind: 3, late: 4 } },
  { why: "kind 0, below the enum", fields: { kind: 0 } },
  { why: "kind 99, past the enum", fields: { kind: 99 } },
  {
    why: "every integer at its extreme",
    fields: {
      mono: U64,
      tai: U64,
      cookie: U64,
      cgid: U64,
      netns: U32,
      saddr: [255, 255, 255, 255],
      daddr: [0, 0, 0, 0],
      pid: -2_147_483_648,
      err: -2_147_483_648,
      state: 2_147_483_647,
      owner: -1,
      fd: -1,
      oldst: -1,
      newst: 2_147_483_647,
      sport: 0,
      dport: 65_535,
      tcp: Array.from({ length: 15 }, () => U32),
      seg: [U32, U32, U32, U32],
      kind: 13,
    },
  },
  {
    why: "a timer's counts at their extreme",
    fields: { kind: 14, extra: 1, hasSeg: 0, behind: U32, late: U32 },
  },
  { why: "an empty name", fields: { comm: [] } },
  { why: "a name of all 16 bytes, no NUL", fields: { comm: bytesOf("abcdefghijklmnop") } },
  { why: "a quote and a backslash", fields: { comm: bytesOf('a"b\\c') } },
  {
    why: "control characters, and DEL, which JSON leaves alone",
    fields: { comm: [0x0a, 0x09, 0x01, 0x08, 0x0c, 0x0d, 0x1f, 0x7f] },
  },
  {
    why: "bytes past the first NUL are not the name",
    fields: { comm: [0x61, 0x62, 0x00, 0x63, 0x64] },
  },
  {
    why: "valid two- and three-byte UTF-8",
    fields: { comm: [0xc3, 0xa9, 0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac] },
  },
  { why: "a byte that never starts a sequence", fields: { comm: [0x61, 0xff, 0x62] } },
  { why: "a three-byte sequence cut short: one U+FFFD", fields: { comm: [0xe2, 0x82] } },
  { why: "a broken continuation, then ASCII that survives", fields: { comm: [0xe2, 0x82, 0x41] } },
  { why: "an overlong encoding: two U+FFFD", fields: { comm: [0xc0, 0x80] } },
  { why: "a surrogate: three U+FFFD", fields: { comm: [0xed, 0xa0, 0x80] } },
  { why: "past U+10FFFF", fields: { comm: [0xf4, 0x90, 0x80, 0x80] } },
  { why: "a four-byte sequence cut short", fields: { comm: [0xf0, 0x9f, 0x98] } },
  { why: "a lone continuation byte", fields: { comm: [0x80] } },
  {
    why: "a sequence cut by the 16-byte limit",
    fields: { comm: [...bytesOf("abcdefghijklmn"), 0xe6, 0x97] },
  },
];

/** This function gives the bytes of the fixture: the record of each case, then a record cut to 12 bytes. */
export const fixture = (): Uint8Array => {
  const records = CASES.map(({ fields }) => encode({ ...BASE, ...fields }));
  const cut = encode(BASE).slice(0, 12);
  const out = new Uint8Array(records.length * RECORD_SIZE + cut.length);
  records.forEach((record, index) => out.set(record, index * RECORD_SIZE));
  out.set(cut, records.length * RECORD_SIZE);
  return out;
};
