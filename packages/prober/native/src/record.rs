//! The record the kernel side writes (`bpf/prober.h`'s `struct ev`), decoded field by field
//! without `unsafe`, and the JSON line the harness reads.
//!
//! A line's keys are in byte order, as serde_json writes any object it holds as a map. The
//! structs below declare their fields in that order and serialize straight to the writer: no map
//! is built per record, and the Go and C collectors write the same bytes (the identity fixture).

use crate::{quantity, Quantity};
use serde::{Serialize, Serializer};
use std::borrow::Cow;
use std::net::Ipv4Addr;

/// `struct ev`'s size in bytes. In order: seven u64, five u32, seven i32, two u16, two u32,
/// `struct tcp_now` (nine u32), `struct seg` (four u32), two u32 for a timer and a 16-byte comm.
/// Every field sits on its own alignment, so the C compiler adds no padding.
pub const SIZE: usize = 192;

/// The event kinds, in `prober.h`'s order, from 1.
const KINDS: [&str; 14] = [
    "state", "accept", "retrans", "rst_tx", "rst_rx", "error", "destroy", "tw_enter", "tw_kill",
    "req_new", "rst_v4", "probe", "rx", "timer",
];

/// ICSK_TIME_LOSS_PROBE in include/net/inet_connection_sock.h: the tail loss probe is armed
const ICSK_TIME_LOSS_PROBE: u32 = 5;

/// `prober.h`'s TIMER_OWNED: a timer record's flag that the socket's owner held the socket
const TIMER_OWNED: u32 = 0x100;

#[derive(Debug, Clone, PartialEq)]
pub struct TcpNow {
    pub retransmits: u32,
    pub pending: u32,
    pub backoff: u32,
    pub probes_out: u32,
    /// icsk_rto, in jiffies
    pub rto: u32,
    pub srtt_us: u32,
    pub snd_una: u32,
    pub snd_nxt: u32,
    pub rcv_nxt: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Seg {
    pub seq: u32,
    pub ack: u32,
    pub len: u32,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ev {
    pub mono: u64,
    pub tai: u64,
    pub cookie: u64,
    pub nscookie: u64,
    pub cgid: u64,
    pub skaddr: u64,
    pub ino: u64,
    pub kind: u32,
    pub netns: u32,
    pub saddr: Ipv4Addr,
    pub daddr: Ipv4Addr,
    pub extra: u32,
    pub pid: i32,
    pub fd: i32,
    pub oldst: i32,
    pub newst: i32,
    pub state: i32,
    pub err: i32,
    pub owner: i32,
    pub sport: u16,
    pub dport: u16,
    pub tcp: Option<TcpNow>,
    pub seg: Option<Seg>,
    /// a timer: how many jiffies behind its wheel slot the CPU ran it
    pub behind: u32,
    /// and how many after the expiry its owner asked for
    pub late: u32,
    /// the task's name as the kernel holds it: up to 16 bytes, not always UTF-8
    pub comm_raw: [u8; 16],
    pub comm_len: usize,
}

/// Reads native-endian fields in order from a record's bytes.
struct Fields<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Fields<'a> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        out.copy_from_slice(&self.bytes[self.at..self.at + N]);
        self.at += N;
        out
    }
    fn u64(&mut self) -> u64 {
        u64::from_ne_bytes(self.take())
    }
    fn u32(&mut self) -> u32 {
        u32::from_ne_bytes(self.take())
    }
    fn i32(&mut self) -> i32 {
        i32::from_ne_bytes(self.take())
    }
    fn u16(&mut self) -> u16 {
        u16::from_ne_bytes(self.take())
    }
    /// an IPv4 address the kernel holds in network order
    fn addr(&mut self) -> Ipv4Addr {
        Ipv4Addr::from(self.take::<4>())
    }
}

impl Ev {
    /// Decodes one ring-buffer record, or says why it cannot.
    pub fn decode(bytes: &[u8]) -> Result<Ev, String> {
        if bytes.len() != SIZE {
            return Err(format!("a record is {SIZE} bytes, not {}", bytes.len()));
        }
        let mut f = Fields { bytes, at: 0 };
        let (mono, tai, cookie, nscookie, cgid, skaddr, ino) =
            (f.u64(), f.u64(), f.u64(), f.u64(), f.u64(), f.u64(), f.u64());
        let (kind, netns, saddr, daddr, extra) = (f.u32(), f.u32(), f.addr(), f.addr(), f.u32());
        let (pid, fd, oldst, newst, state, err, owner) =
            (f.i32(), f.i32(), f.i32(), f.i32(), f.i32(), f.i32(), f.i32());
        let (sport, dport) = (f.u16(), f.u16());
        let (has_tcp, has_seg) = (f.u32(), f.u32());
        let tcp = TcpNow {
            retransmits: f.u32(),
            pending: f.u32(),
            backoff: f.u32(),
            probes_out: f.u32(),
            rto: f.u32(),
            srtt_us: f.u32(),
            snd_una: f.u32(),
            snd_nxt: f.u32(),
            rcv_nxt: f.u32(),
        };
        let seg = Seg { seq: f.u32(), ack: f.u32(), len: f.u32(), flags: f.u32() };
        let (behind, late) = (f.u32(), f.u32());
        let comm_raw = f.take::<16>();
        let comm_len = comm_raw.iter().position(|&b| b == 0).unwrap_or(comm_raw.len());
        Ok(Ev {
            mono,
            tai,
            cookie,
            nscookie,
            cgid,
            skaddr,
            ino,
            kind,
            netns,
            saddr,
            daddr,
            extra,
            pid,
            fd,
            oldst,
            newst,
            state,
            err,
            owner,
            sport,
            dport,
            tcp: (has_tcp != 0).then_some(tcp),
            seg: (has_seg != 0).then_some(seg),
            behind,
            late,
            comm_raw,
            comm_len,
        })
    }

    /// The task's name, its broken UTF-8 replaced as `String::from_utf8_lossy` replaces it.
    pub fn comm(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.comm_raw[..self.comm_len])
    }

    pub fn kind_name(&self) -> &'static str {
        (self.kind as usize)
            .checked_sub(1)
            .and_then(|at| KINDS.get(at))
            .copied()
            .unwrap_or("unknown")
    }

    /// What a retransmission was: the tail loss probe, the RTO timer's, or one from ACK
    /// processing. Only the RTO timer's count toward tcp_retries2; the first of them starts the
    /// give-up's budget.
    pub fn retransmission(&self) -> Option<&'static str> {
        let tcp = self.tcp.as_ref()?;
        Some(if tcp.pending == ICSK_TIME_LOSS_PROBE {
            "tlp"
        } else if tcp.pending == 0 && tcp.retransmits > 0 {
            "rto"
        } else {
            "fast"
        })
    }
}

/// The record's TCP state, its keys in byte order.
#[derive(Serialize)]
pub struct TcpOut {
    pub backoff: u32,
    pub pending: u32,
    pub probes_out: u32,
    pub rcv_nxt: u32,
    pub retransmits: u32,
    pub rto: Quantity,
    pub snd_nxt: u32,
    pub snd_una: u32,
    pub srtt: Quantity,
}

/// The record's segment, its keys in byte order.
#[derive(Serialize)]
pub struct SegOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    pub len: Quantity,
    pub seq: u32,
}

/// An address and port, written as `a.b.c.d:port` without building a string first.
pub struct Endpoint(pub Ipv4Addr, pub u16);

impl Serialize for Endpoint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&format_args!("{}:{}", self.0, self.1))
    }
}

/// One JSON line, its keys in byte order.
#[derive(Serialize)]
pub struct Record<'a> {
    /// a reset sent with no segment to answer: an active reset
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// a timer: how many jiffies behind its wheel slot it ran
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<Quantity>,
    pub cg: u64,
    pub comm: Cow<'a, str>,
    pub cookie: u64,
    pub dst: Endpoint,
    pub err: i32,
    pub ev: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fd: Option<i32>,
    /// a timer: how many jiffies after its expiry it ran
    #[serde(skip_serializing_if = "Option::is_none")]
    pub late: Option<Quantity>,
    pub mono: u64,
    pub netns: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<i32>,
    /// a timer: whether the socket's owner held the socket as it ran
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned: Option<bool>,
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seg: Option<SegOut>,
    pub src: Endpoint,
    pub state: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tai: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tcp: Option<TcpOut>,
    /// a probe: keepalive, window or other; a timer: keepalive, retransmit or other
    #[serde(skip_serializing_if = "Option::is_none")]
    pub what: Option<&'static str>,
    /// a retransmission: tlp, rto or fast
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
}

impl<'a> From<&'a Ev> for Record<'a> {
    fn from(e: &'a Ev) -> Record<'a> {
        let name = e.kind_name();
        // a connect or an accept names the task that owns the socket, and its fd
        let has_owner = e.owner != 0;
        let state_change = name == "state";
        let timer = name == "timer";
        Record {
            ev: name,
            mono: e.mono,
            tai: (e.tai != 0).then_some(e.tai),
            cookie: e.cookie,
            netns: e.netns,
            cg: e.cgid,
            pid: e.pid,
            comm: e.comm(),
            src: Endpoint(e.saddr, e.sport),
            dst: Endpoint(e.daddr, e.dport),
            state: e.state,
            err: e.err,
            old: state_change.then_some(e.oldst),
            new: state_change.then_some(e.newst),
            fd: has_owner.then_some(e.fd),
            behind: timer.then(|| quantity(e.behind, "jiffy")),
            late: timer.then(|| quantity(e.late, "jiffy")),
            owned: timer.then_some(e.extra & TIMER_OWNED != 0),
            why: if name == "retrans" { e.retransmission() } else { None },
            // a timer's kind is its extra's low byte, beside the owned flag
            what: match (name, if timer { e.extra & 0xff } else { e.extra }) {
                ("probe" | "timer", 1) => Some("keepalive"),
                ("probe", 2) => Some("window"),
                ("timer", 2) => Some("retransmit"),
                ("probe" | "timer", _) => Some("other"),
                _ => None,
            },
            active: (name == "rst_tx").then_some(e.extra == 1),
            x: match name {
                "error" | "tw_enter" | "tw_kill" | "req_new" | "rst_v4" => Some(e.extra),
                _ => None,
            },
            tcp: e.tcp.as_ref().map(|t| TcpOut {
                retransmits: t.retransmits,
                pending: t.pending,
                backoff: t.backoff,
                probes_out: t.probes_out,
                rto: quantity(t.rto, "jiffy"),
                srtt: quantity(t.srtt_us, "us"),
                snd_una: t.snd_una,
                snd_nxt: t.snd_nxt,
                rcv_nxt: t.rcv_nxt,
            }),
            seg: e.seg.as_ref().map(|s| SegOut {
                seq: s.seq,
                ack: (name == "rx").then_some(s.ack),
                len: quantity(s.len, "B"),
                flags: (name == "rx").then_some(s.flags),
            }),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// the line by hand: what `Record` serializes, written straight into a buffer
// ---------------------------------------------------------------------------------------------

fn push_u64(out: &mut Vec<u8>, mut v: u64) {
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    loop {
        at -= 1;
        digits[at] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    out.extend_from_slice(&digits[at..]);
}

fn push_i64(out: &mut Vec<u8>, v: i64) {
    if v < 0 {
        out.push(b'-');
    }
    push_u64(out, v.unsigned_abs());
}

/// One byte of a JSON string as serde_json writes it: \" \\ \b \f \n \r \t, other control
/// characters as \u00xx in lowercase hex, everything else as it is.
fn push_escaped(out: &mut Vec<u8>, c: u8) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    match c {
        b'"' => out.extend_from_slice(b"\\\""),
        b'\\' => out.extend_from_slice(b"\\\\"),
        0x08 => out.extend_from_slice(b"\\b"),
        0x0c => out.extend_from_slice(b"\\f"),
        b'\n' => out.extend_from_slice(b"\\n"),
        b'\r' => out.extend_from_slice(b"\\r"),
        b'\t' => out.extend_from_slice(b"\\t"),
        c if c < 0x20 => {
            out.extend_from_slice(b"\\u00");
            out.push(HEX[(c >> 4) as usize]);
            out.push(HEX[(c & 0xf) as usize]);
        }
        c => out.push(c),
    }
}

/// Raw bytes as a JSON string, decoded as `String::from_utf8_lossy` decodes them: each maximal
/// prefix of a would-be UTF-8 sequence that cannot complete becomes one U+FFFD, and decoding
/// resumes at the byte that broke it. The Go and C collectors run this same loop.
fn push_lossy_quoted(out: &mut Vec<u8>, b: &[u8]) {
    const REPLACEMENT: &[u8] = "\u{FFFD}".as_bytes();
    out.push(b'"');
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c < 0x80 {
            push_escaped(out, c);
            i += 1;
            continue;
        }
        let (need, lo, hi) = match c {
            0xc2..=0xdf => (1, 0x80, 0xbf),
            0xe0 => (2, 0xa0, 0xbf),
            0xed => (2, 0x80, 0x9f),
            0xe1..=0xef => (2, 0x80, 0xbf),
            0xf0 => (3, 0x90, 0xbf),
            0xf4 => (3, 0x80, 0x8f),
            0xf1..=0xf3 => (3, 0x80, 0xbf),
            _ => {
                out.extend_from_slice(REPLACEMENT);
                i += 1;
                continue;
            }
        };
        let mut j = i + 1;
        let mut whole = true;
        for k in 0..need {
            let (first, last) = if k == 0 { (lo, hi) } else { (0x80, 0xbf) };
            match b.get(j) {
                Some(&next) if (first..=last).contains(&next) => j += 1,
                _ => {
                    whole = false;
                    break;
                }
            }
        }
        if whole {
            out.extend_from_slice(&b[i..j]);
        } else {
            out.extend_from_slice(REPLACEMENT);
        }
        i = j;
    }
    out.push(b'"');
}

/// `{"unit":"…","value":N.0}`: every amount a record carries is a whole u32, which serde writes
/// as a float
fn push_quantity(out: &mut Vec<u8>, value: u32, unit: &str) {
    out.extend_from_slice(b"{\"unit\":\"");
    out.extend_from_slice(unit.as_bytes());
    out.extend_from_slice(b"\",\"value\":");
    push_u64(out, value.into());
    out.extend_from_slice(b".0}");
}

/// `"a.b.c.d:port"`
fn push_endpoint(out: &mut Vec<u8>, addr: Ipv4Addr, port: u16) {
    out.push(b'"');
    for (k, octet) in addr.octets().into_iter().enumerate() {
        if k > 0 {
            out.push(b'.');
        }
        push_u64(out, octet.into());
    }
    out.push(b':');
    push_u64(out, port.into());
    out.push(b'"');
}

impl Ev {
    /// Appends the record's JSON line, the bytes `Record` serializes to, written by hand: its keys
    /// in byte order, straight into the buffer, building nothing per record. The Go and C
    /// collectors write it the same way, and the tests hold it to `Record`'s output.
    pub fn append_line(&self, out: &mut Vec<u8>) {
        let name = self.kind_name();
        out.push(b'{');
        if name == "rst_tx" {
            out.extend_from_slice(if self.extra == 1 { b"\"active\":true," } else { b"\"active\":false," });
        }
        if name == "timer" {
            out.extend_from_slice(b"\"behind\":");
            push_quantity(out, self.behind, "jiffy");
            out.push(b',');
        }
        out.extend_from_slice(b"\"cg\":");
        push_u64(out, self.cgid);
        out.extend_from_slice(b",\"comm\":");
        push_lossy_quoted(out, &self.comm_raw[..self.comm_len]);
        out.extend_from_slice(b",\"cookie\":");
        push_u64(out, self.cookie);
        out.extend_from_slice(b",\"dst\":");
        push_endpoint(out, self.daddr, self.dport);
        out.extend_from_slice(b",\"err\":");
        push_i64(out, self.err.into());
        out.extend_from_slice(b",\"ev\":\"");
        out.extend_from_slice(name.as_bytes());
        out.push(b'"');
        if self.owner != 0 {
            out.extend_from_slice(b",\"fd\":");
            push_i64(out, self.fd.into());
        }
        if name == "timer" {
            out.extend_from_slice(b",\"late\":");
            push_quantity(out, self.late, "jiffy");
        }
        out.extend_from_slice(b",\"mono\":");
        push_u64(out, self.mono);
        out.extend_from_slice(b",\"netns\":");
        push_u64(out, self.netns.into());
        if name == "state" {
            out.extend_from_slice(b",\"new\":");
            push_i64(out, self.newst.into());
            out.extend_from_slice(b",\"old\":");
            push_i64(out, self.oldst.into());
        }
        if name == "timer" {
            out.extend_from_slice(if self.extra & TIMER_OWNED != 0 {
                b",\"owned\":true".as_slice()
            } else {
                b",\"owned\":false"
            });
        }
        out.extend_from_slice(b",\"pid\":");
        push_i64(out, self.pid.into());
        if let Some(s) = &self.seg {
            out.extend_from_slice(b",\"seg\":{");
            if name == "rx" {
                out.extend_from_slice(b"\"ack\":");
                push_u64(out, s.ack.into());
                out.extend_from_slice(b",\"flags\":");
                push_u64(out, s.flags.into());
                out.push(b',');
            }
            out.extend_from_slice(b"\"len\":");
            push_quantity(out, s.len, "B");
            out.extend_from_slice(b",\"seq\":");
            push_u64(out, s.seq.into());
            out.push(b'}');
        }
        out.extend_from_slice(b",\"src\":");
        push_endpoint(out, self.saddr, self.sport);
        out.extend_from_slice(b",\"state\":");
        push_i64(out, self.state.into());
        if self.tai != 0 {
            out.extend_from_slice(b",\"tai\":");
            push_u64(out, self.tai);
        }
        if let Some(t) = &self.tcp {
            out.extend_from_slice(b",\"tcp\":{\"backoff\":");
            push_u64(out, t.backoff.into());
            out.extend_from_slice(b",\"pending\":");
            push_u64(out, t.pending.into());
            out.extend_from_slice(b",\"probes_out\":");
            push_u64(out, t.probes_out.into());
            out.extend_from_slice(b",\"rcv_nxt\":");
            push_u64(out, t.rcv_nxt.into());
            out.extend_from_slice(b",\"retransmits\":");
            push_u64(out, t.retransmits.into());
            out.extend_from_slice(b",\"rto\":");
            push_quantity(out, t.rto, "jiffy");
            out.extend_from_slice(b",\"snd_nxt\":");
            push_u64(out, t.snd_nxt.into());
            out.extend_from_slice(b",\"snd_una\":");
            push_u64(out, t.snd_una.into());
            out.extend_from_slice(b",\"srtt\":");
            push_quantity(out, t.srtt_us, "us");
            out.push(b'}');
        }
        if name == "probe" || name == "timer" {
            let kind = if name == "timer" { self.extra & 0xff } else { self.extra };
            out.extend_from_slice(match (name, kind) {
                (_, 1) => b",\"what\":\"keepalive\"".as_slice(),
                ("probe", 2) => b",\"what\":\"window\"",
                (_, 2) => b",\"what\":\"retransmit\"",
                _ => b",\"what\":\"other\"",
            });
        }
        if name == "retrans" {
            if let Some(why) = self.retransmission() {
                out.extend_from_slice(b",\"why\":\"");
                out.extend_from_slice(why.as_bytes());
                out.push(b'"');
            }
        }
        if matches!(name, "error" | "tw_enter" | "tw_kill" | "req_new" | "rst_v4") {
            out.extend_from_slice(b",\"x\":");
            push_u64(out, self.extra.into());
        }
        out.push(b'}');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a record as the kernel side lays it out, built field by field in `struct ev`'s order
    fn raw(kind: u32, retransmits: u32, pending: u32) -> Vec<u8> {
        let mut b = Vec::with_capacity(SIZE);
        for v in [1_000_u64, 0, 42, 7, 9, 0xffff, 0] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        b.extend_from_slice(&kind.to_ne_bytes());
        b.extend_from_slice(&4026532000_u32.to_ne_bytes());
        b.extend_from_slice(&[172, 21, 0, 3]);
        b.extend_from_slice(&[172, 21, 0, 2]);
        b.extend_from_slice(&0_u32.to_ne_bytes());
        for v in [100_i32, -1, 0, 0, 1, 0, 0] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        b.extend_from_slice(&41978_u16.to_ne_bytes());
        b.extend_from_slice(&6379_u16.to_ne_bytes());
        b.extend_from_slice(&1_u32.to_ne_bytes());
        b.extend_from_slice(&1_u32.to_ne_bytes());
        for v in [retransmits, pending, 1, 0, 102, 80, 10, 16, 20] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        for v in [10_u32, 0, 6, 0] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        for v in [2_u32, 10] {
            b.extend_from_slice(&v.to_ne_bytes());
        }
        let mut comm = [0u8; 16];
        comm[..6].copy_from_slice(b"client");
        b.extend_from_slice(&comm);
        b
    }

    #[test]
    fn decodes_a_record_and_names_the_rto_timers_retransmission() {
        let ev = Ev::decode(&raw(3, 1, 0)).unwrap();
        assert_eq!(ev.kind_name(), "retrans");
        assert_eq!(ev.saddr, Ipv4Addr::new(172, 21, 0, 3));
        assert_eq!((ev.sport, ev.dport), (41978, 6379));
        assert_eq!(ev.comm(), "client");
        assert_eq!(ev.retransmission(), Some("rto"));
        let json = serde_json::to_value(Record::from(&ev)).unwrap();
        assert_eq!(json["why"], "rto");
        assert_eq!(json["src"], "172.21.0.3:41978");
        assert_eq!(json["tcp"]["rto"], serde_json::json!({ "value": 102.0, "unit": "jiffy" }));
    }

    #[test]
    fn tells_the_tail_loss_probe_from_the_rto_timer() {
        // the loss probe is armed (pending 5) and no RTO retransmission has happened
        assert_eq!(Ev::decode(&raw(3, 0, ICSK_TIME_LOSS_PROBE)).unwrap().retransmission(), Some("tlp"));
        // a retransmission in ACK processing, with the RTO timer armed (pending 1)
        assert_eq!(Ev::decode(&raw(3, 0, 1)).unwrap().retransmission(), Some("fast"));
    }

    #[test]
    fn says_how_far_behind_its_wheel_slot_a_sockets_timer_ran() {
        // extra, after seven u64, the kind, the namespace and two addresses: the retransmit timer
        let mut bytes = raw(14, 0, 0);
        bytes[72..76].copy_from_slice(&2_u32.to_ne_bytes());
        let ev = Ev::decode(&bytes).unwrap();
        assert_eq!(ev.kind_name(), "timer");
        let json = serde_json::to_value(Record::from(&ev)).unwrap();
        assert_eq!(json["what"], "retransmit");
        assert_eq!(json["behind"], serde_json::json!({ "value": 2.0, "unit": "jiffy" }));
        assert_eq!(json["late"], serde_json::json!({ "value": 10.0, "unit": "jiffy" }));
        assert_eq!(json["owned"], false);
        // the same timer, finding its socket in its owner's hands
        bytes[72..76].copy_from_slice(&(1_u32 | TIMER_OWNED).to_ne_bytes());
        let held = serde_json::to_value(Record::from(&Ev::decode(&bytes).unwrap())).unwrap();
        assert_eq!((&held["what"], &held["owned"]), (&serde_json::json!("keepalive"), &serde_json::json!(true)));
        // no other kind says either
        let other = serde_json::to_value(Record::from(&Ev::decode(&raw(3, 1, 0)).unwrap())).unwrap();
        assert!(other.get("behind").is_none() && other.get("late").is_none() && other.get("owned").is_none());
    }

    #[test]
    fn refuses_a_record_of_the_wrong_size() {
        assert!(Ev::decode(&[0u8; 12]).unwrap_err().contains("192 bytes"));
    }

    /// every whole record of the identity fixture, which the Go and C collectors are held to
    const FIXTURE: &[u8] = include_bytes!("../../fixtures/records.bin");

    #[test]
    fn writes_by_hand_exactly_what_serde_and_from_utf8_lossy_write() {
        let mut checked = 0;
        for chunk in FIXTURE.chunks_exact(SIZE) {
            let ev = Ev::decode(chunk).unwrap();
            let mut by_hand = Vec::new();
            ev.append_line(&mut by_hand);
            let by_serde = serde_json::to_vec(&Record::from(&ev)).unwrap();
            assert_eq!(
                String::from_utf8_lossy(&by_hand),
                String::from_utf8_lossy(&by_serde),
                "record {checked}"
            );
            checked += 1;
        }
        assert_eq!(checked, 46);
    }
}
