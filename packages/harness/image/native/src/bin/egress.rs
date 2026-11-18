//! egress sink PORT
//! egress send --qdisc WORDS --burst AT_MS:COUNT:PAYLOAD [--burst ...] [--settle-ms N] [--wait-s N] HOST PORT [--mode M] [--max-s N]
//!
//! This program is the client of the egress cells, and the sink of their target. Each line is JSON
//! with an `ev` and a `t` on CLOCK_MONOTONIC.
//!
//! `sink` binds a UDP port and discards each datagram. Without a listener, the target answers a
//! datagram with an ICMP port unreachable, and IP_RECVERR makes it the error of a later send.
//!
//! `send` puts the qdisc of `--qdisc` (the words of `tc`) at the root of eth0, and sends bursts of
//! UDP datagrams through it to the sink. The steps:
//!
//! 1. One datagram before the qdisc resolves the address of the target. The program then makes that
//!    neighbour permanent, thus no ARP packet goes through the qdisc during the bursts.
//! 2. `tc qdisc replace` sets the qdisc, and `tc -j` reads it back.
//! 3. SO_TIMESTAMPING asks for two stamps of each datagram: SCHED before the enqueue in the qdisc,
//!    and SND when the device takes it from the qdisc. OPT_ID gives each datagram a key, from 0 in
//!    the order of the sends. A datagram that the qdisc drops takes a key and a SCHED stamp too.
//! 4. After `--settle-ms`, the program reads the counts of the qdisc, and writes `ready`.
//! 5. Each burst starts at its time after the first, and its datagrams go back to back. A send that
//!    the qdisc drops gives ENOBUFS, because IP_RECVERR is set.
//! 6. The program reads the error queue until each stamp is there, or `--wait-s` passes.
//!
//! The last lines are one `packet` line for each datagram, `stats` with the counts of the qdisc
//! before and after, `clock` with the step of CLOCK_REALTIME during the run, and `done`. The stamps
//! are on CLOCK_REALTIME. The program moves them to CLOCK_MONOTONIC with the offset of the clocks
//! before the bursts, thus a step of the clock makes the run void.

use harness_native::{emit, emit_at};
use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::error::Error;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::os::fd::AsRawFd;
use std::process::Command;
use std::time::Duration;

/// the interface of the container, which the qdisc goes on
const DEVICE: &str = "eth0";
const SECOND_NS: u64 = 1_000_000_000;
const MS_NS: u64 = 1_000_000;
/// The kernel doubles this size. A datagram in a qdisc keeps its memory on the socket until it
/// leaves, and a stamp in the error queue keeps its memory on the socket until a read.
const BUFFER: libc::c_int = 4 << 20;
/// the bytes of the IPv4 header and the UDP header
const HEADERS: usize = 28;
/// the time from the `ready` line to the first burst
const LEAD_NS: u64 = 20 * MS_NS;
/// the longest wait for the address of the target
const RESOLVE_MS: u64 = 2_000;
const USAGE: &str = "egress sink PORT | egress send --qdisc WORDS --burst AT_MS:COUNT:PAYLOAD... HOST PORT";

// The values of linux/net_tstamp.h, linux/errqueue.h and asm-generic/socket.h for a 64-bit time_t.
const SO_TIMESTAMPING: libc::c_int = 37;
const SOF_TIMESTAMPING_TX_SOFTWARE: u32 = 1 << 1;
const SOF_TIMESTAMPING_SOFTWARE: u32 = 1 << 4;
const SOF_TIMESTAMPING_OPT_ID: u32 = 1 << 7;
const SOF_TIMESTAMPING_TX_SCHED: u32 = 1 << 8;
const SOF_TIMESTAMPING_OPT_TSONLY: u32 = 1 << 11;
const SO_EE_ORIGIN_TIMESTAMPING: u8 = 4;
const SCM_TSTAMP_SND: u32 = 0;
const SCM_TSTAMP_SCHED: u32 = 1;

/// `struct sock_extended_err` of linux/errqueue.h. For a stamp, `info` is its kind and `data` is the
/// key of its datagram. The layout needs each field, also the fields that no code reads.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct ExtendedErr {
    errno: u32,
    origin: u8,
    kind: u8,
    code: u8,
    pad: u8,
    info: u32,
    data: u32,
}

/// One `struct __kernel_old_timespec` of `struct scm_timestamping`, for a 64-bit time_t.
#[repr(C)]
#[derive(Clone, Copy)]
struct Stamp {
    sec: i64,
    nsec: i64,
}

#[derive(Debug, PartialEq)]
struct Burst {
    at_ns: u64,
    count: u32,
    payload: usize,
}

#[derive(Debug, PartialEq)]
struct Plan {
    qdisc: Vec<String>,
    bursts: Vec<Burst>,
    settle_ms: u64,
    wait_s: u64,
    target: SocketAddrV4,
}

/// Reads one burst: its time in milliseconds after the first burst, its count of datagrams and the
/// bytes of the payload of each.
fn burst_of(text: &str) -> Result<Burst, Box<dyn Error>> {
    let mut parts = text.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(at), Some(count), Some(payload), None) => {
            let at: f64 = at.parse()?;
            if !at.is_finite() || at < 0.0 {
                return Err(format!("the time of a burst is not {at}").into());
            }
            let count: u32 = count.parse()?;
            if count == 0 {
                return Err(format!("the burst {text} has no datagram").into());
            }
            Ok(Burst { at_ns: (at * MS_NS as f64).round() as u64, count, payload: payload.parse()? })
        }
        _ => Err(format!("a burst is AT_MS:COUNT:PAYLOAD, not {text}").into()),
    }
}

/// Reads the flags of `send`. The harness gives the place of the target, `--mode` and `--max-s` to each client.
fn plan_of(args: &[String]) -> Result<Plan, Box<dyn Error>> {
    let mut qdisc = Vec::new();
    let mut bursts = Vec::new();
    let mut settle_ms = 200;
    let mut wait_s = 5;
    let mut place = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--qdisc" => qdisc = value()?.split_whitespace().map(String::from).collect(),
            "--burst" => bursts.push(burst_of(value()?)?),
            "--settle-ms" => settle_ms = value()?.parse()?,
            "--wait-s" => wait_s = value()?.parse()?,
            "--mode" | "--max-s" => {
                value()?;
            }
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            other => place.push(other.to_string()),
        }
    }
    if qdisc.is_empty() {
        return Err("send needs --qdisc".into());
    }
    if bursts.is_empty() {
        return Err("send needs a --burst".into());
    }
    if bursts.windows(2).any(|pair| pair[1].at_ns < pair[0].at_ns) {
        return Err("the bursts are not in the order of their times".into());
    }
    let [host, port] = place.as_slice() else {
        return Err(format!("send needs HOST PORT, not {place:?}").into());
    };
    Ok(Plan { qdisc, bursts, settle_ms, wait_s, target: SocketAddrV4::new(host.parse()?, port.parse()?) })
}

fn sink(args: &[String]) -> Result<(), Box<dyn Error>> {
    let port: u16 = args.first().ok_or("egress sink PORT")?.parse()?;
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port))?;
    emit("listening", json!({ "port": port }));
    let mut buffer = vec![0u8; 65_536];
    loop {
        socket.recv_from(&mut buffer)?;
    }
}

/// The name of an errno, or the text of an error with no errno.
fn errno_of(error: &std::io::Error) -> String {
    error.raw_os_error().map_or_else(|| error.to_string(), errno_name)
}

fn set(fd: libc::c_int, level: libc::c_int, name: libc::c_int, value: libc::c_int, what: &str) -> Result<(), Box<dyn Error>> {
    // SAFETY: the value is on this stack, passed with its exact size
    let status = unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (&value as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{what}: {}", errno_of(&std::io::Error::last_os_error())).into())
    }
}

fn realtime_ns() -> u64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime only writes the timespec it is handed, which is on this stack
    let status = unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut now) };
    assert_eq!(status, 0, "clock_gettime(CLOCK_REALTIME) failed");
    now.tv_sec as u64 * SECOND_NS + now.tv_nsec as u64
}

/// The offset of CLOCK_REALTIME from CLOCK_MONOTONIC, from one read of each clock.
fn offset_ns() -> i128 {
    let before = monotonic_ns();
    let real = realtime_ns();
    let after = monotonic_ns();
    real as i128 - (before as i128 + after as i128) / 2
}

/// Sleeps until an instant on CLOCK_MONOTONIC, or gives at once when it has passed.
fn until(at: u64) -> Result<(), Box<dyn Error>> {
    let deadline = libc::timespec {
        // the fields' own types: musl is moving time_t to 64 bits
        tv_sec: (at / SECOND_NS) as _,
        tv_nsec: (at % SECOND_NS) as _,
    };
    loop {
        // SAFETY: a valid timespec, and no remainder is asked for with an absolute time
        let code = unsafe { libc::clock_nanosleep(libc::CLOCK_MONOTONIC, libc::TIMER_ABSTIME, &deadline, std::ptr::null_mut()) };
        match code {
            0 => return Ok(()),
            libc::EINTR => continue,
            other => return Err(format!("clock_nanosleep failed: {other}").into()),
        }
    }
}

/// The output of a program, or an error with its standard error.
fn output(program: &str, args: &[&str]) -> Result<String, Box<dyn Error>> {
    let out = Command::new(program).args(args).output().map_err(|error| format!("{program}: {error}"))?;
    if !out.status.success() {
        return Err(format!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()).into());
    }
    Ok(String::from_utf8(out.stdout)?)
}

/// The JSON of `ip -j` or `tc -j`. An empty output is an empty list.
fn listed(text: &str) -> Result<Vec<Value>, Box<dyn Error>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(text.trim())? {
        Value::Array(each) => Ok(each),
        other => Err(format!("{other} is not a list").into()),
    }
}

/// The link address and the states of the neighbour `host` on the device, when it has an address.
fn neighbour_of(entries: &[Value]) -> Option<(String, Vec<String>)> {
    let entry = entries.iter().find(|entry| entry["lladdr"].is_string())?;
    let states = entry["state"].as_array().map(|each| each.iter().filter_map(|state| state.as_str().map(String::from)).collect()).unwrap_or_default();
    Some((entry["lladdr"].as_str()?.to_string(), states))
}

fn neighbour(host: Ipv4Addr) -> Result<Option<(String, Vec<String>)>, Box<dyn Error>> {
    let text = output("ip", &["-j", "neigh", "show", &host.to_string(), "dev", DEVICE])?;
    Ok(neighbour_of(&listed(&text)?))
}

/// Waits for the address of the target, after the first datagram, and makes the neighbour permanent.
fn pin(host: Ipv4Addr) -> Result<Value, Box<dyn Error>> {
    let end = monotonic_ns() + RESOLVE_MS * MS_NS;
    let address = loop {
        match neighbour(host)? {
            Some((address, states)) if !states.iter().any(|state| state == "INCOMPLETE" || state == "FAILED") => break address,
            _ if monotonic_ns() > end => return Err(format!("no address for {host} in {RESOLVE_MS} ms").into()),
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    output("ip", &["neigh", "replace", &host.to_string(), "lladdr", &address, "dev", DEVICE, "nud", "permanent"])?;
    let (address, states) = neighbour(host)?.ok_or("the neighbour is gone after its replace")?;
    Ok(json!({ "lladdr": address, "state": states }))
}

/// The root qdisc of the device, with its counts.
fn root_of(entries: &[Value]) -> Result<Value, Box<dyn Error>> {
    entries.iter().find(|entry| entry["root"] == true).cloned().ok_or_else(|| "tc shows no root qdisc".into())
}

fn root() -> Result<Value, Box<dyn Error>> {
    root_of(&listed(&output("tc", &["-s", "-j", "qdisc", "show", "dev", DEVICE])?)?)
}

/// The counts of a qdisc that the judge compares with the sends.
fn counts_of(qdisc: &Value) -> Value {
    json!({
        "packets": qdisc["packets"],
        "bytes": qdisc["bytes"],
        "drops": qdisc["drops"],
        "overlimits": qdisc["overlimits"],
        "requeues": qdisc["requeues"],
        "qlen": qdisc["qlen"],
    })
}

/// One stamp of the error queue: its kind (`SCM_TSTAMP_*`), the key of its datagram and its time on
/// CLOCK_REALTIME.
#[derive(Debug, PartialEq)]
struct Read {
    kind: u32,
    key: u32,
    at: u64,
}

/// The stamp of one message of the error queue, from its control messages.
///
/// # Safety
/// `msg` is the header of a message that `recvmsg` filled.
unsafe fn read_of(msg: &libc::msghdr) -> Option<Read> {
    let mut at = None;
    let mut err = None;
    let mut cmsg = libc::CMSG_FIRSTHDR(msg);
    while !cmsg.is_null() {
        let (level, kind) = ((*cmsg).cmsg_level, (*cmsg).cmsg_type);
        let body = libc::CMSG_DATA(cmsg);
        if level == libc::SOL_SOCKET && kind == SO_TIMESTAMPING {
            // ts[0] is the stamp of the software, the other two are of the hardware
            let stamp = std::ptr::read_unaligned(body.cast::<Stamp>());
            at = Some(stamp.sec as u64 * SECOND_NS + stamp.nsec as u64);
        } else if level == libc::SOL_IP && kind == libc::IP_RECVERR {
            err = Some(std::ptr::read_unaligned(body.cast::<ExtendedErr>()));
        }
        cmsg = libc::CMSG_NXTHDR(msg, cmsg);
    }
    match (at, err) {
        (Some(at), Some(err)) if err.origin == SO_EE_ORIGIN_TIMESTAMPING => Some(Read { kind: err.info, key: err.data, at }),
        _ => None,
    }
}

/// Takes one message of the error queue. It gives None when the queue is empty.
fn take(fd: libc::c_int) -> Result<Option<Read>, Box<dyn Error>> {
    let mut data = [0u8; 256];
    // u64 cells, thus the buffer has the alignment of a cmsghdr
    let mut control = [0u64; 128];
    let mut iov = libc::iovec { iov_base: data.as_mut_ptr().cast(), iov_len: data.len() };
    // SAFETY: a msghdr of zeros is a valid header with no address, and the fields below point at this stack
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = std::mem::size_of_val(&control) as _;
    // SAFETY: the header and its buffers are on this stack, and live for the whole call
    let got = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT) };
    if got < 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::EAGAIN) => Ok(None),
            _ => Err(format!("recvmsg of the error queue: {}", errno_of(&error)).into()),
        };
    }
    // SAFETY: recvmsg filled the header
    Ok(unsafe { read_of(&msg) }.or(Some(Read { kind: u32::MAX, key: u32::MAX, at: 0 })))
}

/// One datagram of a burst: its key, its burst, the end of its send and its errno.
struct Sent {
    key: u32,
    burst: usize,
    payload: usize,
    call: u64,
    errno: Option<String>,
}

fn send(plan: &Plan) -> Result<(), Box<dyn Error>> {
    let mtu: usize = {
        let path = format!("/sys/class/net/{DEVICE}/mtu");
        std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?.trim().parse()?
    };
    if let Some(burst) = plan.bursts.iter().find(|burst| burst.payload + HEADERS > mtu) {
        return Err(format!("a payload of {} bytes needs two fragments at an MTU of {mtu}", burst.payload).into());
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    socket.connect(plan.target)?;
    let fd = socket.as_raw_fd();
    set(fd, libc::SOL_SOCKET, libc::SO_SNDBUFFORCE, BUFFER, "SO_SNDBUFFORCE")?;
    set(fd, libc::SOL_SOCKET, libc::SO_RCVBUFFORCE, BUFFER, "SO_RCVBUFFORCE")?;
    set(fd, libc::SOL_IP, libc::IP_RECVERR, 1, "IP_RECVERR")?;
    // the first datagram goes before the qdisc and the stamps: it resolves the address of the target
    socket.send(&[0])?;
    let neighbour = pin(*plan.target.ip())?;
    let mut words = vec!["qdisc", "replace", "dev", DEVICE, "root"];
    words.extend(plan.qdisc.iter().map(String::as_str));
    output("tc", &words)?;
    let flags = SOF_TIMESTAMPING_TX_SCHED | SOF_TIMESTAMPING_TX_SOFTWARE | SOF_TIMESTAMPING_SOFTWARE | SOF_TIMESTAMPING_OPT_ID | SOF_TIMESTAMPING_OPT_TSONLY;
    set(fd, libc::SOL_SOCKET, SO_TIMESTAMPING, flags as libc::c_int, "SO_TIMESTAMPING")?;
    let payloads: Vec<Vec<u8>> = plan.bursts.iter().map(|burst| vec![0u8; burst.payload]).collect();
    std::thread::sleep(Duration::from_millis(plan.settle_ms));
    // a stamp of the first datagram, or of other traffic, goes before the count of the run
    while take(fd)?.is_some() {}
    let before = root()?;
    let offset = offset_ns();
    emit("ready", json!({ "mtu": mtu, "qdisc": before, "neighbour": neighbour }));
    let start = monotonic_ns() + LEAD_NS;
    let mut sent = Vec::new();
    let mut key = 0u32;
    for (index, burst) in plan.bursts.iter().enumerate() {
        until(start + burst.at_ns)?;
        for _ in 0..burst.count {
            let outcome = socket.send(&payloads[index]);
            let call = monotonic_ns();
            let errno = match outcome {
                Ok(bytes) if bytes == burst.payload => None,
                Ok(bytes) => return Err(format!("a send of {} bytes wrote {bytes}", burst.payload).into()),
                Err(error) => Some(errno_of(&error)),
            };
            sent.push(Sent { key, burst: index, payload: burst.payload, call, errno });
            key += 1;
        }
    }
    let wanted = sent.len() + sent.iter().filter(|each| each.errno.is_none()).count();
    let end = monotonic_ns() + plan.wait_s * SECOND_NS;
    let mut sched: HashMap<u32, u64> = HashMap::new();
    let mut left: HashMap<u32, u64> = HashMap::new();
    let mut other = 0u32;
    while sched.len() + left.len() < wanted && monotonic_ns() < end {
        match take(fd)? {
            Some(Read { kind: SCM_TSTAMP_SCHED, key, at }) => {
                sched.insert(key, at);
            }
            Some(Read { kind: SCM_TSTAMP_SND, key, at }) => {
                left.insert(key, at);
            }
            Some(_) => other += 1,
            None => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    let after = root()?;
    let step = offset_ns() - offset;
    // a stamp on CLOCK_REALTIME, on CLOCK_MONOTONIC with the offset before the bursts
    let monotonic = |at: Option<&u64>| at.map(|&at| (at as i128 - offset) as u64);
    for each in &sent {
        emit_at(
            "packet",
            each.call,
            json!({
                "key": each.key,
                "burst": each.burst,
                "payload": each.payload,
                "errno": each.errno,
                "sched": monotonic(sched.get(&each.key)),
                "left": monotonic(left.get(&each.key)),
            }),
        );
    }
    emit("stats", json!({ "before": counts_of(&before), "after": counts_of(&after), "kind": after["kind"] }));
    emit("clock", json!({ "step": step as i64 }));
    emit(
        "done",
        json!({
            "sends": sent.len(),
            "dropped": sent.iter().filter(|each| each.errno.is_some()).count(),
            "sched": sched.len(),
            "left": left.len(),
            "other": other,
            "start": start,
        }),
    );
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("sink") => sink(&args[1..]),
        Some("send") => plan_of(&args[1..]).and_then(|plan| send(&plan)),
        _ => Err(USAGE.into()),
    };
    // an error is a line too: the harness ends the run at it, and the judge makes the run void
    if let Err(error) = outcome {
        emit("error", json!({ "what": error.to_string() }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(each: &[&str]) -> Vec<String> {
        each.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn a_send_reads_its_qdisc_and_its_bursts_and_skips_the_flags_of_the_harness() {
        let plan = plan_of(&argv(&[
            "--qdisc", "netem delay 100ms rate 10mbit limit 12", "--burst", "0:8:1472", "--burst", "30:8:1472",
            "10.0.0.2", "6393", "--mode", "idle", "--max-s", "20",
        ]))
        .expect("a plan");
        assert_eq!(plan.qdisc, ["netem", "delay", "100ms", "rate", "10mbit", "limit", "12"]);
        assert_eq!(plan.bursts, [Burst { at_ns: 0, count: 8, payload: 1472 }, Burst { at_ns: 30 * MS_NS, count: 8, payload: 1472 }]);
        assert_eq!(plan.target, SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 2), 6393));
        assert_eq!((plan.settle_ms, plan.wait_s), (200, 5));
    }

    #[test]
    fn a_send_refuses_a_plan_with_no_qdisc_no_burst_or_bursts_out_of_order() {
        assert!(plan_of(&argv(&["--burst", "0:1:1", "10.0.0.2", "6393"])).is_err());
        assert!(plan_of(&argv(&["--qdisc", "netem", "10.0.0.2", "6393"])).is_err());
        assert!(plan_of(&argv(&["--qdisc", "netem", "--burst", "5:1:1", "--burst", "1:1:1", "10.0.0.2", "6393"])).is_err());
        assert!(plan_of(&argv(&["--qdisc", "netem", "--burst", "0:1:1", "10.0.0.2"])).is_err());
        assert!(plan_of(&argv(&["--qdisc", "netem", "--burst", "0:1:1", "--no-such", "1", "10.0.0.2", "6393"])).is_err());
        assert!(burst_of("0:0:100").is_err());
        assert!(burst_of("-1:1:100").is_err());
        assert!(burst_of("0:1").is_err());
        assert_eq!(burst_of("12.5:3:958").expect("a burst"), Burst { at_ns: 12_500_000, count: 3, payload: 958 });
    }

    #[test]
    fn the_json_of_ip_and_tc_gives_the_neighbour_and_the_root_qdisc() {
        let neighbours = listed(r#"[{"dst":"10.0.0.2","lladdr":"02:42:0a:00:00:02","state":["PERMANENT"]}]"#).expect("a list");
        assert_eq!(neighbour_of(&neighbours), Some(("02:42:0a:00:00:02".to_string(), vec!["PERMANENT".to_string()])));
        assert_eq!(neighbour_of(&listed(r#"[{"dst":"10.0.0.2","state":["INCOMPLETE"]}]"#).expect("a list")), None);
        assert!(listed("").expect("a list").is_empty());
        assert!(listed("{}").is_err());
        let qdiscs = listed(
            r#"[{"kind":"tbf","handle":"8001:","root":true,"options":{"rate":125000,"burst":3000},"bytes":0,"packets":0,"drops":0,"overlimits":0,"requeues":0,"qlen":0},
                {"kind":"bfifo","handle":"0:","parent":"8001:1","options":{"limit":30000},"bytes":0,"packets":0,"drops":0}]"#,
        )
        .expect("a list");
        let root = root_of(&qdiscs).expect("a root");
        assert_eq!(root["kind"], "tbf");
        assert_eq!(counts_of(&root)["drops"], 0);
        assert!(root_of(&qdiscs[1..]).is_err());
    }

    #[test]
    fn the_constants_of_the_stamps_are_those_of_the_kernel_headers() {
        assert_eq!(std::mem::size_of::<ExtendedErr>(), 16);
        assert_eq!(std::mem::size_of::<Stamp>(), 16);
        assert_eq!(SOF_TIMESTAMPING_TX_SCHED | SOF_TIMESTAMPING_TX_SOFTWARE | SOF_TIMESTAMPING_SOFTWARE | SOF_TIMESTAMPING_OPT_ID | SOF_TIMESTAMPING_OPT_TSONLY, 0x992);
    }

    #[test]
    fn the_clocks_give_an_offset_that_does_not_step_between_two_reads() {
        let (first, second) = (offset_ns(), offset_ns());
        assert!((second - first).abs() < 1_000_000);
    }
}
