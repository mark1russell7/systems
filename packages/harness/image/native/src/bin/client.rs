//! client HOST PORT --mode idle|inflight [--keepalive] [--user-timeout-ms N] [--go PATH]
//!        [--request TEXT] [--sample-ms N] [--max-s N]
//!
//! A cell's TCP client: one connection, every event a JSON line stamped on CLOCK_MONOTONIC. It
//! sets no per-socket TCP timer unless the cell asks, so the namespace's sysctls are what gets
//! measured: Rust's std::net turns nothing on by itself. While it waits, it samples the kernel's
//! view of its own socket (TCP_INFO) every --sample-ms and logs each change, a second vantage
//! beside the prober's records. It waits in poll(), never holding its socket's lock, so it never
//! puts off the socket's own keepalive timer.
//!
//! Both modes send one request and read its reply first; that reply is the last segment received.
//! idle: then hold the connection idle until it fails.
//! inflight: then wait for the file --go to appear, send the request again, and wait. --request
//! names that second request, a Redis inline command: PING unless it says otherwise. BLPOP with a
//! timeout makes the server answer only when the timeout runs out, so its reply can be the one in
//! flight when a fault lands.

use prober::{errno_name, monotonic_ns, quantity};
use serde_json::{json, Value};
use std::error::Error;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::Duration;

/// a Redis inline command; any line-based server echoes or errors on it, which is a reply too
const REQUEST: &[u8] = b"PING\r\n";

fn emit(event: &str, fields: Value) {
    emit_at(event, monotonic_ns(), fields);
}

fn emit_at(event: &str, t: u64, fields: Value) {
    let mut line = json!({ "ev": event, "t": t });
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    println!("{line}");
}

/// Sends the request, stamped before the write: on a bridge, the kernel can take a reset to the
/// request before write() returns, and a stamp after it would come later than the reset's own.
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
    keepalive: bool,
    user_timeout_ms: Option<i32>,
    go: String,
    sample: Duration,
    max: Duration,
    /// the request sent at --go, with its line ending
    request: Vec<u8>,
}

fn args() -> Result<Args, Box<dyn Error>> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| raw.iter().position(|arg| arg == flag).and_then(|at| raw.get(at + 1)).cloned();
    let mode = value("--mode").ok_or("--mode idle|inflight is required")?;
    if mode != "idle" && mode != "inflight" {
        return Err(format!("--mode is idle or inflight, not {mode}").into());
    }
    Ok(Args {
        host: raw.first().ok_or("the target's host comes first")?.clone(),
        port: raw.get(1).ok_or("then its port")?.parse()?,
        inflight: mode == "inflight",
        keepalive: raw.iter().any(|arg| arg == "--keepalive"),
        user_timeout_ms: value("--user-timeout-ms").map(|v| v.parse()).transpose()?,
        go: value("--go").unwrap_or_else(|| "/tmp/go".into()),
        sample: Duration::from_micros((value("--sample-ms").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(2.0) * 1000.0) as u64),
        max: Duration::from_secs_f64(value("--max-s").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(60.0)),
        request: value("--request").map_or_else(|| REQUEST.to_vec(), |r| format!("{r}\r\n").into_bytes()),
    })
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = args()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_string();
    emit("start", json!({ "boot_id": boot_id, "mode": if args.inflight { "inflight" } else { "idle" } }));
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
    // read that waits takes the socket's lock each time it wakes, and a keepalive timer that finds
    // the socket held puts itself off by HZ/20: the client would move the timer
    // it measures
    stream.set_nonblocking(true)?;
    let tick = args.sample.as_millis().clamp(1, i32::MAX as u128) as i32;
    let mut waiting = args.inflight;
    let mut seen: Option<[u32; 7]> = None;
    let mut age = info.tcpi_last_ack_recv;
    loop {
        if readable(fd, tick)? {
            match stream.read(&mut buf) {
                Ok(0) => {
                    emit("eof", json!({}));
                    return Ok(());
                }
                Ok(n) => emit("data", json!({ "n": n, "text": String::from_utf8_lossy(&buf[..n.min(40)]) })),
                // nothing after all; ETIMEDOUT is the connection's own end
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
