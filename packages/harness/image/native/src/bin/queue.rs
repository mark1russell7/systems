//! queue target PORT
//! queue client [--backlog N] [--fill N] [--settle-ms N] [--burst N] [--blocked] [--late-ms N]
//!              [--accept N] [--accept-at-ms N] [--hold-ms N] [--drain] HOST PORT [--mode M] [--max-s N]
//!
//! This program is the two ends of the accept queue cells: a listener that does not accept, and a
//! client of many connections. Each line is JSON with an `ev` and a `t` on CLOCK_MONOTONIC.
//!
//! The target serves commands on PORT + 1, its control port, one line for each command:
//!
//! - `open BACKLOG`: closes the listener of the run before, and calls listen(2) on PORT with
//!   BACKLOG. Thus each run starts with an empty queue. The harness sets the sysctls of the
//!   namespace after the target starts, and listen(2) reads somaxconn in this command, after them.
//! - `accept COUNT`: takes up to COUNT connections from the queue.
//! - `stats`: gives the count and the counters at this time.
//!
//! A second thread reads the queue each 5 ms, and it writes a `queue` line for each change. TCP_INFO
//! of a listener gives the count (`tcpi_unacked`) and the limit (`tcpi_sacked`). /proc/net/netstat
//! gives the counters of the namespace.
//!
//! The client does these steps in sequence:
//!
//! 1. It opens the listener and writes `ready`.
//! 2. `--fill` connections, each one after the one before ends or `--settle-ms` passes.
//! 3. `--burst` connections at one time: `in`, `busy` and `quiet`. All of their SYNs arrive inside
//!    one round trip. `in` and `busy` send one byte when they connect.
//! 4. `--blocked` adds one connection after the burst.
//! 5. It waits until each connection after the fill ends, or `--hold-ms` passes after the burst. In
//!    this wait, `quiet` sends one byte at `--late-ms`, and the target accepts `--accept`
//!    connections at `--accept-at-ms`.
//! 6. It writes the state of each connection, drains the queue with `--drain`, and writes the
//!    counters and `done`.

use harness_native::{emit, emit_at};
use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::error::Error;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// the names of the connections of a burst, in the sequence of their SYNs
const BURST: [&str; 3] = ["in", "busy", "quiet"];
/// how long a burst waits for its handshakes, in nanoseconds
const HANDSHAKE_NS: u64 = 300_000_000;
/// the longest count that a drain asks for
const DRAIN: i32 = 1024;

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

fn socket_error(fd: i32) -> std::io::Result<i32> {
    let mut code: i32 = 0;
    let mut len = std::mem::size_of::<i32>() as libc::socklen_t;
    // SAFETY: the option value is an int on this stack, passed with its exact size
    let status = unsafe {
        libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_ERROR, (&mut code as *mut i32).cast(), &mut len)
    };
    if status == 0 { Ok(code) } else { Err(std::io::Error::last_os_error()) }
}

/// the counters of /proc/net/netstat that the law of the queue reads
#[derive(Clone, Copy, Default, PartialEq)]
struct Counters {
    overflows: u64,
    drops: u64,
    cookies: u64,
    timeouts: u64,
    resets: u64,
}

/// Reads the counters from the text of /proc/net/netstat: a line of names, then a line of values.
fn counters_of(text: &str) -> Counters {
    let mut found = Counters::default();
    let mut lines = text.lines();
    while let (Some(names), Some(values)) = (lines.next(), lines.next()) {
        if !names.starts_with("TcpExt:") {
            continue;
        }
        for (name, value) in names.split_whitespace().zip(values.split_whitespace()) {
            let value = value.parse::<u64>().unwrap_or(0);
            match name {
                "ListenOverflows" => found.overflows = value,
                "ListenDrops" => found.drops = value,
                "TCPReqQFullDoCookies" => found.cookies = value,
                "TCPTimeouts" => found.timeouts = value,
                "EmbryonicRsts" => found.resets = value,
                _ => {}
            }
        }
    }
    found
}

fn counters() -> Counters {
    std::fs::read_to_string("/proc/net/netstat").map(|text| counters_of(&text)).unwrap_or_default()
}

fn fields(count: u32, max: u32, seen: Counters) -> Value {
    json!({
        "count": count,
        "max": max,
        "overflows": seen.overflows,
        "drops": seen.drops,
        "cookies": seen.cookies,
        "timeouts": seen.timeouts,
        "resets": seen.resets,
    })
}

/// the listener of the run, and the connections that it accepted
#[derive(Default)]
struct Queue {
    listener: Option<i32>,
    accepted: Vec<i32>,
}

fn locked(queue: &Mutex<Queue>) -> MutexGuard<'_, Queue> {
    queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads the count and the limit of the queue, with the lock held: `open` closes the listener under it.
fn reading(queue: &Mutex<Queue>) -> Option<(u32, u32)> {
    let held = locked(queue);
    let info = tcp_info(held.listener?).ok()?;
    Some((info.tcpi_unacked, info.tcpi_sacked))
}

fn stats(queue: &Mutex<Queue>) -> Value {
    let (count, max) = reading(queue).unwrap_or((0, 0));
    fields(count, max, counters())
}

fn open(queue: &Mutex<Queue>, port: u16, backlog: i32) -> Result<Value, Box<dyn Error>> {
    let mut held = locked(queue);
    for fd in held.accepted.drain(..) {
        // SAFETY: this program opened each descriptor, and it closes each one time
        unsafe { libc::close(fd) };
    }
    if let Some(fd) = held.listener.take() {
        // SAFETY: as above. The close resets each connection that the queue still holds
        unsafe { libc::close(fd) };
    }
    // SAFETY: socket(2) takes no pointer
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_NONBLOCK, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    set_int(fd, libc::SOL_SOCKET, libc::SO_REUSEADDR, 1)?;
    // SAFETY: sockaddr_in is plain old data. Zero is INADDR_ANY
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_port = port.to_be();
    // SAFETY: the address is on this stack, passed with its exact size
    let bound = unsafe {
        libc::bind(
            fd,
            (&address as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    };
    // SAFETY: listen(2) takes no pointer
    if bound != 0 || unsafe { libc::listen(fd, backlog) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    held.listener = Some(fd);
    drop(held);
    Ok(stats(queue))
}

fn accept(queue: &Mutex<Queue>, count: i32) -> Result<Value, Box<dyn Error>> {
    let mut held = locked(queue);
    let fd = held.listener.ok_or("no listener")?;
    let mut peers = Vec::new();
    for _ in 0..count {
        // SAFETY: sockaddr_in is plain old data
        let mut peer: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
        // SAFETY: the kernel writes at most `len` bytes to the address on this stack
        let child = unsafe { libc::accept(fd, (&mut peer as *mut libc::sockaddr_in).cast(), &mut len) };
        // the listener does not block: an empty queue gives EAGAIN
        if child < 0 {
            break;
        }
        held.accepted.push(child);
        peers.push(u16::from_be(peer.sin_port));
    }
    Ok(json!({ "peers": peers }))
}

fn serve(stream: TcpStream, queue: &Mutex<Queue>, port: u16) -> Result<(), Box<dyn Error>> {
    stream.set_nodelay(true)?;
    let mut writer = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        let mut words = line.split_whitespace();
        let command = words.next();
        let number = words.next().and_then(|word| word.parse::<i32>().ok());
        let reply = match (command, number) {
            (Some("open"), Some(backlog)) => open(queue, port, backlog)?,
            (Some("accept"), Some(count)) => accept(queue, count)?,
            (Some("stats"), _) => stats(queue),
            _ => json!({ "refused": line }),
        };
        writeln!(writer, "{reply}")?;
    }
    Ok(())
}

/// Writes a `queue` line for each change of the queue or of its counters, until the process ends.
fn sample(queue: &Mutex<Queue>) {
    let mut last = None;
    loop {
        let now = reading(queue).map(|(count, max)| (count, max, counters()));
        if now != last {
            if let Some((count, max, seen)) = now {
                emit("queue", fields(count, max, seen));
            }
            last = now;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn target(args: &[String]) -> Result<(), Box<dyn Error>> {
    let port: u16 = args.first().ok_or("queue target PORT")?.parse()?;
    let queue = Arc::new(Mutex::new(Queue::default()));
    let sampled = Arc::clone(&queue);
    std::thread::spawn(move || sample(&sampled));
    let control = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port + 1))?;
    emit("listening", json!({ "control": port + 1 }));
    for stream in control.incoming() {
        if let Err(error) = serve(stream?, &queue, port) {
            emit("control-error", json!({ "error": error.to_string() }));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Dialing,
    Open,
    Ended,
}

struct Connection {
    name: String,
    fd: i32,
    local: String,
    phase: Phase,
}

fn local_of(fd: i32) -> std::io::Result<String> {
    // SAFETY: sockaddr_in is plain old data
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
    // SAFETY: the kernel writes at most `len` bytes to the address on this stack
    let status = unsafe { libc::getsockname(fd, (&mut address as *mut libc::sockaddr_in).cast(), &mut len) };
    if status != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let ip = Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
    Ok(format!("{ip}:{}", u16::from_be(address.sin_port)))
}

/// Starts one connection and does not wait. The stamp comes before connect(2), which sends the SYN.
fn dial(name: &str, ip: Ipv4Addr, port: u16) -> Result<Connection, Box<dyn Error>> {
    // SAFETY: socket(2) takes no pointer
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_NONBLOCK, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: sockaddr_in is plain old data
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_port = port.to_be();
    address.sin_addr.s_addr = u32::from_ne_bytes(ip.octets());
    let t = monotonic_ns();
    // SAFETY: the address is on this stack, passed with its exact size
    let status = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    };
    if status != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error.into());
        }
    }
    let local = local_of(fd)?;
    emit_at("dial", t, json!({ "name": name, "local": local }));
    Ok(Connection { name: name.to_string(), fd, local, phase: Phase::Dialing })
}

/// Waits up to `ms` for a change of the given connections, and writes one line for each change.
fn watch(connections: &mut [Connection], ms: i32) -> std::io::Result<()> {
    let mut wanted: Vec<libc::pollfd> = connections
        .iter()
        .map(|each| libc::pollfd {
            // poll(2) skips a negative descriptor
            fd: if each.phase == Phase::Ended { -1 } else { each.fd },
            events: if each.phase == Phase::Dialing { libc::POLLOUT } else { libc::POLLIN },
            revents: 0,
        })
        .collect();
    // SAFETY: the vector holds its length of pollfds
    let ready = unsafe { libc::poll(wanted.as_mut_ptr(), wanted.len() as libc::nfds_t, ms) };
    if ready < 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == ErrorKind::Interrupted { Ok(()) } else { Err(error) };
    }
    for (each, seen) in connections.iter_mut().zip(&wanted) {
        if seen.revents == 0 {
            continue;
        }
        let code = socket_error(each.fd)?;
        if code != 0 {
            emit("failed", json!({ "name": each.name, "errno": errno_name(code) }));
            each.phase = Phase::Ended;
        } else if each.phase == Phase::Dialing {
            emit("connected", json!({ "name": each.name, "local": each.local }));
            each.phase = Phase::Open;
        } else {
            emit("closed", json!({ "name": each.name }));
            each.phase = Phase::Ended;
        }
    }
    Ok(())
}

/// Sends one byte, stamped before the write.
fn send(connection: &Connection) {
    let t = monotonic_ns();
    // SAFETY: the buffer holds the one byte that the call reads
    let written = unsafe { libc::write(connection.fd, b"x".as_ptr().cast(), 1) };
    emit_at("sent", t, json!({ "name": connection.name, "written": written }));
}

/// the control connection of the client: one line for each command, and one line for each reply
struct Control {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Control {
    fn ask(&mut self, command: &str) -> Result<Value, Box<dyn Error>> {
        writeln!(self.writer, "{command}")?;
        let mut reply = String::new();
        self.reader.read_line(&mut reply)?;
        Ok(serde_json::from_str(&reply)?)
    }
}

#[derive(Default)]
struct Plan {
    host: String,
    port: u16,
    backlog: i32,
    fill: usize,
    settle_ms: i32,
    burst: usize,
    blocked: bool,
    late_ms: Option<u64>,
    accept: i32,
    accept_at_ms: Option<u64>,
    hold_ms: u64,
    drain: bool,
}

fn plan_of(args: &[String]) -> Result<Plan, Box<dyn Error>> {
    let mut plan = Plan { settle_ms: 300, ..Plan::default() };
    let mut places = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--backlog" => plan.backlog = value()?.parse()?,
            "--fill" => plan.fill = value()?.parse()?,
            "--settle-ms" => plan.settle_ms = value()?.parse()?,
            "--burst" => plan.burst = value()?.parse()?,
            "--blocked" => plan.blocked = true,
            "--late-ms" => plan.late_ms = Some(value()?.parse()?),
            "--accept" => plan.accept = value()?.parse()?,
            "--accept-at-ms" => plan.accept_at_ms = Some(value()?.parse()?),
            "--hold-ms" => plan.hold_ms = value()?.parse()?,
            "--drain" => plan.drain = true,
            // the harness gives these flags to each client, and the plan does not read them
            "--mode" | "--max-s" => {
                value()?;
            }
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            other => places.push(other.to_string()),
        }
    }
    if let [host, port] = places.as_slice() {
        plan.host = host.clone();
        plan.port = port.parse()?;
        return Ok(plan);
    }
    Err("queue client [flags] HOST PORT".into())
}

fn client(args: &[String]) -> Result<(), Box<dyn Error>> {
    let plan = plan_of(args)?;
    let ip: Ipv4Addr = plan.host.parse()?;
    let stream = TcpStream::connect((ip, plan.port + 1))?;
    stream.set_nodelay(true)?;
    let mut control = Control { reader: BufReader::new(stream.try_clone()?), writer: stream };
    emit("opened", control.ask(&format!("open {}", plan.backlog))?);
    emit("ready", json!({}));

    let mut connections = Vec::new();
    for at in 0..plan.fill {
        connections.push(dial(&format!("fill-{at}"), ip, plan.port)?);
        let last = connections.len() - 1;
        watch(&mut connections[last..], plan.settle_ms)?;
    }

    let first = connections.len();
    let burst_at = monotonic_ns();
    for name in BURST.iter().take(plan.burst) {
        connections.push(dial(name, ip, plan.port)?);
    }
    while connections[first..].iter().any(|each| each.phase == Phase::Dialing)
        && monotonic_ns() < burst_at + HANDSHAKE_NS
    {
        watch(&mut connections[first..], 1)?;
    }
    for each in connections[first..].iter().filter(|each| each.name != "quiet" && each.phase == Phase::Open) {
        send(each);
    }
    if plan.blocked {
        connections.push(dial("blocked", ip, plan.port)?);
    }

    let at_ms = |ms: u64| burst_at + ms * 1_000_000;
    let end = at_ms(plan.hold_ms);
    let mut accept_due = plan.accept_at_ms.map(at_ms);
    let mut late_due = plan.late_ms.map(at_ms);
    loop {
        let now = monotonic_ns();
        if accept_due.is_some_and(|due| now >= due) {
            accept_due = None;
            emit("accepted", control.ask(&format!("accept {}", plan.accept))?);
        }
        if late_due.is_some_and(|due| now >= due) {
            late_due = None;
            for each in connections.iter().filter(|each| each.name == "quiet" && each.phase == Phase::Open) {
                send(each);
            }
        }
        let ended = connections[first..]
            .iter()
            .filter(|each| each.name != "in")
            .all(|each| each.phase == Phase::Ended);
        if now >= end || ended {
            break;
        }
        watch(&mut connections, 5)?;
    }

    for each in &connections {
        if let Ok(info) = tcp_info(each.fd) {
            emit("state", json!({ "name": each.name, "state": info.tcpi_state, "unacked": info.tcpi_unacked }));
        }
    }
    if plan.drain {
        emit("accepted", control.ask(&format!("accept {DRAIN}"))?);
    }
    emit("stats", control.ask("stats")?);
    emit("done", json!({}));
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("target") => target(&args[1..]),
        Some("client") => client(&args[1..]),
        _ => Err("queue target PORT | queue client [flags] HOST PORT".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counters_come_from_the_tcpext_lines_of_netstat() {
        let text = "TcpExt: SyncookiesSent ListenOverflows ListenDrops TCPTimeouts EmbryonicRsts TCPReqQFullDoCookies\n\
                    TcpExt: 1 2 3 4 5 6\n\
                    IpExt: InNoRoutes\n\
                    IpExt: 7\n";
        let found = counters_of(text);
        assert_eq!(found.overflows, 2);
        assert_eq!(found.drops, 3);
        assert_eq!(found.timeouts, 4);
        assert_eq!(found.resets, 5);
        assert_eq!(found.cookies, 6);
    }

    #[test]
    fn a_plan_reads_its_flags_and_skips_the_flags_of_the_harness() {
        let args: Vec<String> = ["--backlog", "4", "--burst", "3", "--blocked", "10.0.0.2", "6390", "--mode", "idle", "--max-s", "90"]
            .iter()
            .map(|each| each.to_string())
            .collect();
        let plan = plan_of(&args).expect("a plan");
        assert_eq!(plan.host, "10.0.0.2");
        assert_eq!(plan.port, 6390);
        assert_eq!(plan.backlog, 4);
        assert_eq!(plan.burst, 3);
        assert!(plan.blocked);
        assert_eq!(plan.settle_ms, 300);
        assert!(plan_of(&["--no-such".to_string()]).is_err());
    }
}
