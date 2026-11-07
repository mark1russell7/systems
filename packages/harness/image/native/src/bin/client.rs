//! client HOST PORT --mode idle|inflight|stream|schedule [--keepalive] [--user-timeout-ms N] [--go PATH]
//!        [--request TEXT] [--count N] [--interval-ms N] [--schedule PATH] [--sample-ms N] [--max-s N]
//!
//! A cell's TCP client: one connection, every event a JSON line stamped on CLOCK_MONOTONIC. It
//! sets no per-socket TCP timer unless the cell asks, so the namespace's sysctls are what gets
//! measured: Rust's std::net turns nothing on by itself. While it waits, it samples the kernel's
//! view of its own socket (TCP_INFO) every --sample-ms and logs each change, a second vantage
//! beside the prober's records. It waits in poll(), never holding its socket's lock, so it never
//! puts off the socket's own keepalive timer.
//!
//! Each mode sends one request and reads its reply first. That reply is the last segment received.
//! idle: then hold the connection idle until it fails.
//! inflight: then wait for the file --go to appear, send the request again, and wait. --request
//! names that second request, a Redis inline command: PING unless it says otherwise. BLPOP with a
//! timeout makes the server answer only when the timeout runs out, so its reply can be the one in
//! flight when a fault lands.
//! stream: then wait for --go, and send the request --count times, each when the reply to the one
//! before it is whole and --interval-ms has passed: a distribution of reply times, for a fault
//! whose outcome is one (loss, reordering). A reply is whole at its CRLF, or for a bulk string
//! after its length: so `GET big` keeps a long reply's many segments in flight, and the replied
//! line stamps its last byte. It ends with a done line.
//! schedule: then wait for --go, and send the request at each time of the file --schedule, a file
//! of the format rigor-schedule/1. A send does not wait for a reply, thus a stall hides no arrival
//! (coordinated omission). The requests share the one connection, and the replies come in their
//! order. The sent and replied lines name their arrival (i). It ends with a done line when each
//! arrival has its reply. An error, an end or the deadline leaves the rest without a reply.

use harness_native::{arrivals_of, emit, emit_at};
use prober::{errno_name, monotonic_ns, quantity};
use serde_json::json;
use std::error::Error;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::Duration;

/// a Redis inline command. Any line-based server echoes it or gives an error, and that is a reply too
const REQUEST: &[u8] = b"PING\r\n";

/// Sends the request, stamped before the write: on a bridge, the kernel can take a reset to the
/// request before write() returns, and a stamp after it comes later than the reset's own.
fn send(stream: &mut TcpStream, request: &[u8]) -> std::io::Result<()> {
    let t = monotonic_ns();
    stream.write_all(request)?;
    emit_at("sent", t, json!({}));
    Ok(())
}

fn set_int(fd: i32, level: i32, name: i32, value: i32) -> std::io::Result<()> {
    // SAFETY: the option value is an int on this stack, passed with its exact size
    let status = unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (&value as *const i32).cast(),
            std::mem::size_of::<i32>() as libc::socklen_t,
        )
    };
    if status == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

fn tcp_info(fd: i32) -> std::io::Result<libc::tcp_info> {
    // SAFETY: tcp_info is plain old data, and the kernel writes at most the length it is given
    let mut info: libc::tcp_info = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::tcp_info>() as libc::socklen_t;
    let status = unsafe {
        libc::getsockopt(fd, libc::IPPROTO_TCP, libc::TCP_INFO, (&mut info as *mut libc::tcp_info).cast(), &mut len)
    };
    if status == 0 { Ok(info) } else { Err(std::io::Error::last_os_error()) }
}

/// Whether the socket has something to read, an error or an end, within `ms`: poll() asks the
/// socket without taking its lock.
fn readable(fd: i32, ms: i32) -> std::io::Result<bool> {
    let mut wanted = libc::pollfd { fd, events: libc::POLLIN | libc::POLLRDHUP, revents: 0 };
    // SAFETY: one pollfd on this stack, and its count
    match unsafe { libc::poll(&mut wanted, 1, ms) } {
        -1 if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted => Ok(false),
        -1 => Err(std::io::Error::last_os_error()),
        _ => Ok(wanted.revents != 0),
    }
}

/// The whole length of a Redis reply from its first bytes, or None while its first line is not
/// all there: a simple string, an error or an integer ends at its CRLF, and a bulk string after
/// its length and one more CRLF (a null one, of length -1, at its first CRLF).
fn reply_length(head: &[u8]) -> Option<usize> {
    let line = head.windows(2).position(|pair| pair == b"\r\n")? + 2;
    if head.first() != Some(&b'$') {
        return Some(line);
    }
    let length: i64 = std::str::from_utf8(&head[1..line - 2]).ok()?.parse().ok()?;
    Some(if length < 0 { line } else { line + length as usize + 2 })
}

/// The reply a stream waits for: its first bytes until its length is known, and how much came.
#[derive(Default)]
struct Reply {
    head: Vec<u8>,
    length: Option<usize>,
    got: usize,
}

impl Reply {
    /// Takes the bytes of this reply from the start of `bytes`, and says how many it took. The rest
    /// is the next reply of a pipeline.
    fn consume(&mut self, bytes: &[u8]) -> usize {
        let mut used = 0;
        while self.length.is_none() && used < bytes.len() {
            // a bulk string's first line is its length: 64 bytes hold any
            if self.head.len() < 64 {
                self.head.push(bytes[used]);
            }
            used += 1;
            self.length = reply_length(&self.head);
        }
        self.got += used;
        if let Some(length) = self.length {
            let more = length.saturating_sub(self.got).min(bytes.len() - used);
            self.got += more;
            used += more;
        }
        used
    }

    fn whole(&self) -> bool {
        matches!(self.length, Some(length) if self.got >= length)
    }

    /// Takes the bytes of one read, and says whether the reply is whole.
    fn take(&mut self, bytes: &[u8]) -> bool {
        self.consume(bytes);
        self.whole()
    }
}

/// Waits up to `ns` for the socket, and says if it has something to read and if it takes a write.
/// A wait in ms is too coarse for a schedule, thus this one is ppoll().
fn wait_for(fd: i32, writing: bool, ns: u64) -> std::io::Result<(bool, bool)> {
    let events = libc::POLLIN | libc::POLLRDHUP | if writing { libc::POLLOUT } else { 0 };
    let mut wanted = libc::pollfd { fd, events, revents: 0 };
    let time = libc::timespec { tv_sec: (ns / 1_000_000_000) as libc::time_t, tv_nsec: (ns % 1_000_000_000) as libc::c_long };
    // SAFETY: one pollfd and one timespec on this stack, and no signal mask
    match unsafe { libc::ppoll(&mut wanted, 1, &time, std::ptr::null()) } {
        -1 if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted => Ok((false, false)),
        -1 => Err(std::io::Error::last_os_error()),
        _ => Ok((wanted.revents & !libc::POLLOUT != 0, wanted.revents & libc::POLLOUT != 0)),
    }
}

/// Sends each arrival of `plan` at its time after the file --go appears, whatever the replies do.
/// The stamp of a send comes before the write that ends it. Thus a full socket shows as the lag of
/// each arrival behind it.
fn open_loop(stream: &mut TcpStream, plan: &[u64], args: &Args, deadline: u64) -> Result<(), Box<dyn Error>> {
    let fd = stream.as_raw_fd();
    let tick = args.sample.as_nanos() as u64;
    while !Path::new(&args.go).exists() {
        if monotonic_ns() > deadline {
            emit("deadline", json!({}));
            return Ok(());
        }
        std::thread::sleep(args.sample);
    }
    let start = monotonic_ns();
    emit_at("scheduled", start, json!({ "arrivals": plan.len() }));
    let mut buf = [0u8; 65536];
    let (mut next, mut written, mut answered, mut blocked) = (0usize, 0usize, 0usize, false);
    let mut reply = Reply::default();
    loop {
        while !blocked && next < plan.len() && monotonic_ns() >= start + plan[next] {
            let t = monotonic_ns();
            match stream.write(&args.request[written..]) {
                Ok(n) => {
                    written += n;
                    if written == args.request.len() {
                        emit_at("sent", t, json!({ "i": next }));
                        next += 1;
                        written = 0;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => blocked = true,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    emit("error", json!({ "errno": errno_name(error.raw_os_error().unwrap_or(0)) }));
                    return Ok(());
                }
            }
        }
        if answered == plan.len() {
            emit("done", json!({ "requests": next }));
            return Ok(());
        }
        let now = monotonic_ns();
        if now > deadline {
            emit("deadline", json!({}));
            return Ok(());
        }
        let due = plan.get(next).map_or(tick, |at| (start + at).saturating_sub(now));
        let (can_read, can_write) = wait_for(fd, blocked, due.min(tick))?;
        blocked = blocked && !can_write;
        if !can_read {
            continue;
        }
        match stream.read(&mut buf) {
            Ok(0) => {
                emit("eof", json!({}));
                return Ok(());
            }
            Ok(n) => {
                let t = monotonic_ns();
                let mut at = 0;
                while at < n {
                    at += reply.consume(&buf[at..n]);
                    if reply.whole() {
                        emit_at("replied", t, json!({ "i": answered }));
                        answered += 1;
                        reply = Reply::default();
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::Interrupted => {}
            Err(error) => {
                emit("error", json!({ "errno": errno_name(error.raw_os_error().unwrap_or(0)) }));
                return Ok(());
            }
        }
    }
}

/// what in TCP_INFO is worth a line when it changes: the timers' own state, never the ages
fn watched(info: &libc::tcp_info) -> [u32; 7] {
    [
        info.tcpi_state as u32,
        info.tcpi_retransmits as u32,
        info.tcpi_probes as u32,
        info.tcpi_backoff as u32,
        info.tcpi_rto,
        info.tcpi_unacked,
        info.tcpi_total_retrans,
    ]
}

struct Args {
    host: String,
    port: u16,
    inflight: bool,
    /// in stream mode, how many requests, and the pause after each reply
    stream: Option<u32>,
    interval: Duration,
    keepalive: bool,
    user_timeout_ms: Option<i32>,
    go: String,
    sample: Duration,
    max: Duration,
    /// the request sent at --go, with its line ending
    request: Vec<u8>,
    /// in schedule mode, the file of the arrivals
    schedule: Option<String>,
}

fn args() -> Result<Args, Box<dyn Error>> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| raw.iter().position(|arg| arg == flag).and_then(|at| raw.get(at + 1)).cloned();
    let mode = value("--mode").ok_or("--mode idle|inflight|stream|schedule is required")?;
    if !["idle", "inflight", "stream", "schedule"].contains(&mode.as_str()) {
        return Err(format!("--mode is idle, inflight, stream or schedule, not {mode}").into());
    }
    if mode == "schedule" && value("--schedule").is_none() {
        return Err("--mode schedule needs --schedule".into());
    }
    let count: u32 = value("--count").map(|v| v.parse()).transpose()?.unwrap_or(100);
    Ok(Args {
        host: raw.first().ok_or("the target's host comes first")?.clone(),
        port: raw.get(1).ok_or("then its port")?.parse()?,
        inflight: mode != "idle",
        stream: (mode == "stream").then_some(count),
        interval: Duration::from_millis(value("--interval-ms").map(|v| v.parse()).transpose()?.unwrap_or(20)),
        keepalive: raw.iter().any(|arg| arg == "--keepalive"),
        user_timeout_ms: value("--user-timeout-ms").map(|v| v.parse()).transpose()?,
        go: value("--go").unwrap_or_else(|| "/tmp/go".into()),
        sample: Duration::from_micros((value("--sample-ms").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(2.0) * 1000.0) as u64),
        max: Duration::from_secs_f64(value("--max-s").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(60.0)),
        request: value("--request").map_or_else(|| REQUEST.to_vec(), |r| format!("{r}\r\n").into_bytes()),
        schedule: (mode == "schedule").then(|| value("--schedule")).flatten(),
    })
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = args()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_string();
    let mode = match (args.inflight, args.stream, &args.schedule) {
        (_, _, Some(_)) => "schedule",
        (_, Some(_), None) => "stream",
        (true, None, None) => "inflight",
        (false, None, None) => "idle",
    };
    let plan = args.schedule.as_ref().map(std::fs::read_to_string).transpose()?.map(|text| arrivals_of(&text)).transpose()?;
    emit("start", json!({ "boot_id": boot_id, "mode": mode }));
    let deadline = monotonic_ns() + args.max.as_nanos() as u64;

    let mut stream = TcpStream::connect((args.host.as_str(), args.port))?;
    stream.set_nodelay(true)?;
    let fd = stream.as_raw_fd();
    if args.keepalive {
        set_int(fd, libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1)?;
    }
    if let Some(ms) = args.user_timeout_ms {
        set_int(fd, libc::IPPROTO_TCP, libc::TCP_USER_TIMEOUT, ms)?;
    }
    emit("connected", json!({ "local": stream.local_addr()?.to_string() }));
    send(&mut stream, REQUEST)?;
    let mut buf = [0u8; 65536];
    let n = stream.read(&mut buf)?;
    // the last segment received: a keepalive's idle time counts from here
    let info = tcp_info(fd)?;
    emit(
        "ready",
        json!({
            "reply": String::from_utf8_lossy(&buf[..n.min(40)]),
            "rtt": quantity(info.tcpi_rtt, "us"),
            "rto": quantity(info.tcpi_rto, "us"),
        }),
    );

    // the loop waits in poll(), which takes no lock on the socket, and reads only what is there. A
    // read that waits takes the socket's lock each time it wakes. A keepalive timer that finds the
    // socket held puts itself off by HZ/20. Thus such a read moves the timer that the client measures
    stream.set_nonblocking(true)?;
    if let Some(plan) = &plan {
        return open_loop(&mut stream, plan, &args, deadline);
    }
    let tick = args.sample.as_millis().clamp(1, i32::MAX as u128) as i32;
    let mut waiting = args.inflight;
    let mut seen: Option<[u32; 7]> = None;
    let mut age = info.tcpi_last_ack_recv;
    // stream mode: requests sent, whether one waits for its reply, and when the next can go
    let mut sent: u32 = 0;
    let mut awaiting = false;
    let mut reply = Reply::default();
    let mut next_at: u64 = 0;
    loop {
        if readable(fd, tick)? {
            match stream.read(&mut buf) {
                Ok(0) => {
                    emit("eof", json!({}));
                    return Ok(());
                }
                Ok(n) => {
                    emit("data", json!({ "n": n, "text": String::from_utf8_lossy(&buf[..n.min(40)]) }));
                    if awaiting && reply.take(&buf[..n]) {
                        emit("replied", json!({ "n": quantity(reply.got as u32, "B") }));
                        awaiting = false;
                        reply = Reply::default();
                        next_at = monotonic_ns() + args.interval.as_nanos() as u64;
                    }
                }
                // nothing after all. ETIMEDOUT is the connection's own end
                Err(error) if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    let code = error.raw_os_error().unwrap_or(0);
                    emit("error", json!({ "errno": errno_name(code) }));
                    return Ok(());
                }
            }
        }
        let info = tcp_info(fd)?;
        let now = watched(&info);
        if seen != Some(now) {
            emit(
                "kernel",
                json!({
                    "state": now[0], "retransmits": now[1], "probes": now[2], "backoff": now[3],
                    "rto": quantity(now[4], "us"), "unacked": now[5], "total_retrans": now[6],
                    "last_ack_recv": quantity(info.tcpi_last_ack_recv, "ms"),
                    "last_data_recv": quantity(info.tcpi_last_data_recv, "ms"),
                }),
            );
            seen = Some(now);
        }
        // an ACK arrived since the last sample: what a frozen process's kernel keeps sending
        if info.tcpi_last_ack_recv < age {
            emit("ack", json!({ "last_ack_recv": quantity(info.tcpi_last_ack_recv, "ms") }));
        }
        age = info.tcpi_last_ack_recv;
        if waiting && Path::new(&args.go).exists() {
            send(&mut stream, &args.request)?;
            waiting = false;
            sent = 1;
            awaiting = args.stream.is_some();
        }
        if let Some(count) = args.stream {
            if !waiting && !awaiting {
                if sent >= count {
                    emit("done", json!({ "requests": sent }));
                    return Ok(());
                }
                if monotonic_ns() >= next_at {
                    send(&mut stream, &args.request)?;
                    sent += 1;
                    awaiting = true;
                }
            }
        }
        if monotonic_ns() > deadline {
            emit("deadline", json!({}));
            return Ok(());
        }
    }
}

fn main() {
    if let Err(error) = run() {
        emit("fail", json!({ "why": error.to_string() }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_whole_at_its_crlf_or_after_its_bulk_length() {
        assert_eq!(reply_length(b"+PONG\r\n"), Some(7));
        assert_eq!(reply_length(b"+PON"), None);
        assert_eq!(reply_length(b"$5\r\nhello\r\n"), Some(11));
        assert_eq!(reply_length(b"$-1\r\n"), Some(5));
        assert_eq!(reply_length(b"$1000000\r\nxx"), Some(1_000_012));
        // a long reply in reads of any size: whole only at its last byte
        let mut reply = Reply::default();
        assert!(!reply.take(b"$10\r"));
        assert!(!reply.take(b"\n01234"));
        assert!(!reply.take(b"56789\r"));
        assert!(reply.take(b"\n"));
        assert_eq!(reply.got, 17);
    }

    #[test]
    fn a_pipeline_of_replies_splits_at_each_end_in_reads_of_any_size() {
        let bytes = b"+PONG\r\n$3\r\nabc\r\n+PONG\r\n";
        for size in 1..bytes.len() {
            let (mut reply, mut lengths) = (Reply::default(), Vec::new());
            for read in bytes.chunks(size) {
                let mut at = 0;
                while at < read.len() {
                    at += reply.consume(&read[at..]);
                    if reply.whole() {
                        lengths.push(reply.got);
                        reply = Reply::default();
                    }
                }
            }
            assert_eq!(lengths, [7, 9, 7], "reads of {size}");
        }
    }
}
