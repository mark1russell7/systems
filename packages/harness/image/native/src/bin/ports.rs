//! ports target PORT
//! ports client [--rounds N] [--close reset|client|target] [--destinations N] [--settle-ms N]
//!              [--retry-ms N] [--wait-s N] [--reclaim] HOST PORT [--mode M] [--max-s N]
//!
//! This program is the two ends of the port range cells: a target that accepts each connection,
//! and a client that connects until its range has no port. Each line is JSON with an `ev` and a `t`
//! on CLOCK_MONOTONIC.
//!
//! The target listens on PORT and on PORT + 2, the two destinations of a cell. It serves one command
//! on PORT + 1, its control port: `close COUNT` waits until it holds COUNT connections, and closes them.
//!
//! The client does these steps in each round:
//!
//! 1. It connects to each destination until a connect fails, and it holds each connection. A `round`
//!    line gives the ports of each destination, the errno of the failed connect and its time.
//! 2. `--close reset` closes each connection with a reset. The target then closes its sockets.
//! 3. `--close client` closes each connection with a FIN, and it waits `--settle-ms`. The target
//!    then closes its sockets, between the lines `closing` and `closed`. The client connects again
//!    each `--retry-ms`, until it holds each port or `--wait-s` passes. A `freed` line gives each port.
//!    It then closes those connections with a reset, so that the next run finds each port free.
//! 4. `--close target` makes the target close first. The client reads the FIN of each connection,
//!    closes it, and waits `--settle-ms`. With `--reclaim`, the client reads each FIN first. It then
//!    writes `closing` and closes each connection. It connects again as after `--close client`.
//!
//! With `--mode inflight`, the client writes `ready` and waits for the file `/tmp/go` before its first
//! round. The harness makes this file after it applies the fault, thus the fault acts on each round.
//!
//! The control connection takes a port of the range. Its destination is not a destination of the
//! search, thus it does not change a count. It has SO_LINGER 0 from its connect, so that its close is a
//! reset and holds no port. A FIN at the exit of the client holds that port in TIME_WAIT for 60 s. A
//! range of 3 has only 2 ports for a search. Thus the third run of an environment had no control port.

use harness_native::emit;
use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::error::Error;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// the most connections that one search holds: a guard for a range that the harness did not set
const LIMIT: usize = 256;
/// how long `close COUNT` waits for the accept of the last connection, in milliseconds
const ACCEPT_WAIT_MS: u64 = 2_000;

fn locked(held: &Mutex<Vec<TcpStream>>) -> MutexGuard<'_, Vec<TcpStream>> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Accepts each connection of a port on its own thread.
fn listen(port: u16, held: &Arc<Mutex<Vec<TcpStream>>>) -> std::io::Result<()> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))?;
    let held = Arc::clone(held);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            locked(&held).push(stream);
        }
    });
    Ok(())
}

/// Waits until the target holds `count` connections, and closes each one. It gives the count it closed.
fn close_held(held: &Mutex<Vec<TcpStream>>, count: usize) -> usize {
    for _ in 0..ACCEPT_WAIT_MS {
        if locked(held).len() >= count {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut held = locked(held);
    let closed = held.len();
    held.clear();
    closed
}

fn serve(stream: TcpStream, held: &Mutex<Vec<TcpStream>>) -> Result<(), Box<dyn Error>> {
    stream.set_nodelay(true)?;
    let mut writer = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        let mut words = line.split_whitespace();
        let reply = match (words.next(), words.next().and_then(|word| word.parse::<usize>().ok())) {
            (Some("close"), Some(count)) => json!({ "closed": close_held(held, count) }),
            _ => json!({ "refused": line }),
        };
        writeln!(writer, "{reply}")?;
    }
    Ok(())
}

fn target(args: &[String]) -> Result<(), Box<dyn Error>> {
    let port: u16 = args.first().ok_or("ports target PORT")?.parse()?;
    let held = Arc::new(Mutex::new(Vec::new()));
    listen(port, &held)?;
    listen(port + 2, &held)?;
    let control = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port + 1))?;
    emit("listening", json!({ "control": port + 1 }));
    for stream in control.incoming() {
        if let Err(error) = serve(stream?, &held) {
            emit("control-error", json!({ "error": error.to_string() }));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Close {
    Reset,
    Client,
    Target,
}

#[derive(Debug)]
struct Plan {
    host: String,
    port: u16,
    rounds: u32,
    close: Close,
    destinations: u16,
    settle_ms: u64,
    retry_ms: u64,
    wait_s: u64,
    /// `--mode inflight`: the rounds start when the file of the signal is there, after the fault
    go: bool,
    /// `--reclaim`: after a close of the target, the client connects again until it holds each port
    reclaim: bool,
}

/// the file whose presence tells a client in flight to start
const GO: &str = "/tmp/go";

fn plan_of(args: &[String]) -> Result<Plan, Box<dyn Error>> {
    let mut plan = Plan {
        host: String::new(),
        port: 0,
        rounds: 1,
        close: Close::Reset,
        destinations: 1,
        settle_ms: 50,
        retry_ms: 10,
        wait_s: 80,
        go: false,
        reclaim: false,
    };
    let mut places = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--rounds" => plan.rounds = value()?.parse()?,
            "--close" => {
                plan.close = match value()?.as_str() {
                    "reset" => Close::Reset,
                    "client" => Close::Client,
                    "target" => Close::Target,
                    other => return Err(format!("no way to close named {other}").into()),
                }
            }
            "--destinations" => plan.destinations = value()?.parse()?,
            "--settle-ms" => plan.settle_ms = value()?.parse()?,
            "--retry-ms" => plan.retry_ms = value()?.parse()?,
            "--wait-s" => plan.wait_s = value()?.parse()?,
            "--reclaim" => plan.reclaim = true,
            // the harness gives these flags to each client. The plan reads only the mode in flight
            "--mode" => plan.go = value()? == "inflight",
            "--max-s" => {
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
    Err("ports client [flags] HOST PORT".into())
}

/// the control connection of the client
struct Control {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Control {
    fn ask(&mut self, command: &str) -> Result<Value, Box<dyn Error>> {
        writeln!(self.writer, "{command}")?;
        let mut line = String::new();
        self.reader.read_line(&mut line)?;
        Ok(serde_json::from_str(&line)?)
    }
}

/// Closes a connection with a reset: SO_LINGER with a time of 0, then close(2).
fn reset(stream: TcpStream) -> std::io::Result<()> {
    abortive(&stream)
}

/// Sets SO_LINGER with a time of 0, so that each later close of the socket is a reset.
fn abortive(stream: &TcpStream) -> std::io::Result<()> {
    let linger = libc::linger { l_onoff: 1, l_linger: 0 };
    // SAFETY: the option value is on this stack, passed with its exact size
    let status = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_LINGER,
            (&linger as *const libc::linger).cast(),
            std::mem::size_of::<libc::linger>() as libc::socklen_t,
        )
    };
    if status == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

fn errno_of(error: &std::io::Error) -> String {
    error.raw_os_error().map_or_else(|| error.to_string(), errno_name)
}

/// Connects to one destination until a connect fails, and writes the `round` line.
fn search(index: u32, destination: SocketAddrV4, held: &mut Vec<TcpStream>) -> Result<(), Box<dyn Error>> {
    let mut ports = Vec::new();
    let (errno, refusal) = loop {
        if ports.len() == LIMIT {
            break ("none".to_string(), 0);
        }
        let before = monotonic_ns();
        match TcpStream::connect(destination) {
            Ok(stream) => {
                ports.push(stream.local_addr()?.port());
                held.push(stream);
            }
            Err(error) => break (errno_of(&error), monotonic_ns() - before),
        }
    };
    emit(
        "round",
        json!({ "index": index, "destination": destination.port(), "ports": ports, "errno": errno, "refusal": refusal }),
    );
    Ok(())
}

/// Connects again each `retry_ms` until the client holds `count` ports, or the wait ends.
fn reclaim(plan: &Plan, destination: SocketAddrV4, count: usize) -> Result<Vec<TcpStream>, Box<dyn Error>> {
    let mut again = Vec::new();
    let mut tries = 0u32;
    let end = monotonic_ns() + plan.wait_s * 1_000_000_000;
    while again.len() < count && monotonic_ns() < end {
        match TcpStream::connect(destination) {
            Ok(stream) => {
                emit("freed", json!({ "port": stream.local_addr()?.port(), "tries": tries }));
                again.push(stream);
            }
            Err(error) if error.raw_os_error() == Some(libc::EADDRNOTAVAIL) => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(plan.retry_ms));
            }
            Err(error) => {
                emit("failed", json!({ "errno": errno_of(&error) }));
                break;
            }
        }
    }
    Ok(again)
}

fn close_round(plan: &Plan, first: SocketAddrV4, control: &mut Control, held: Vec<TcpStream>) -> Result<(), Box<dyn Error>> {
    let count = held.len();
    let settle = Duration::from_millis(plan.settle_ms);
    match plan.close {
        Close::Reset => {
            for stream in held {
                reset(stream)?;
            }
            control.ask(&format!("close {count}"))?;
        }
        Close::Client => {
            drop(held);
            std::thread::sleep(settle);
            emit("closing", json!({}));
            let reply = control.ask(&format!("close {count}"))?;
            emit("closed", reply);
            let again = reclaim(plan, first, count)?;
            let reclaimed = again.len();
            for stream in again {
                reset(stream)?;
            }
            control.ask(&format!("close {reclaimed}"))?;
        }
        Close::Target if plan.reclaim => {
            control.ask(&format!("close {count}"))?;
            let mut sink = [0u8; 16];
            for mut stream in &held {
                // each read ends at the FIN of the target
                stream.read(&mut sink)?;
            }
            // the FIN of each connection of the client goes out at this instant: each socket is in LAST_ACK
            emit("closing", json!({}));
            drop(held);
            let again = reclaim(plan, first, count)?;
            let reclaimed = again.len();
            for stream in again {
                reset(stream)?;
            }
            control.ask(&format!("close {reclaimed}"))?;
        }
        Close::Target => {
            control.ask(&format!("close {count}"))?;
            for mut stream in held {
                let mut sink = [0u8; 16];
                // the read ends at the FIN of the target, and the close of the stream sends the FIN of the client
                stream.read(&mut sink)?;
            }
            std::thread::sleep(settle);
        }
    }
    Ok(())
}

fn client(args: &[String]) -> Result<(), Box<dyn Error>> {
    let plan = plan_of(args)?;
    let ip: Ipv4Addr = plan.host.parse()?;
    let stream = TcpStream::connect((ip, plan.port + 1))?;
    // a reset at each close, the exit included: the port of this connection is free for the next run
    abortive(&stream)?;
    stream.set_nodelay(true)?;
    let mut control = Control { reader: BufReader::new(stream.try_clone()?), writer: stream };
    let destinations: Vec<SocketAddrV4> = (0..plan.destinations).map(|at| SocketAddrV4::new(ip, plan.port + 2 * at)).collect();
    emit("ready", json!({}));
    if plan.go {
        let end = monotonic_ns() + plan.wait_s * 1_000_000_000;
        while !std::path::Path::new(GO).exists() {
            if monotonic_ns() > end {
                emit("deadline", json!({}));
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    for index in 0..plan.rounds {
        let mut held = Vec::new();
        for destination in &destinations {
            search(index, *destination, &mut held)?;
        }
        close_round(&plan, destinations[0], &mut control, held)?;
    }
    emit("done", json!({}));
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("target") => target(&args[1..]),
        Some("client") => client(&args[1..]),
        _ => Err("ports target PORT | ports client [flags] HOST PORT".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_reads_its_flags_and_skips_the_flags_of_the_harness() {
        let args: Vec<String> = ["--rounds", "50", "--close", "client", "--destinations", "2", "10.0.0.2", "6392", "--mode", "idle", "--max-s", "90"]
            .iter()
            .map(|each| each.to_string())
            .collect();
        let plan = plan_of(&args).expect("a plan");
        assert_eq!(plan.host, "10.0.0.2");
        assert_eq!(plan.port, 6392);
        assert_eq!(plan.rounds, 50);
        assert_eq!(plan.close, Close::Client);
        assert_eq!(plan.destinations, 2);
        assert_eq!(plan.retry_ms, 10);
        assert!(!plan.go && !plan.reclaim);
        let inflight: Vec<String> = ["--close", "target", "--reclaim", "10.0.0.2", "6392", "--mode", "inflight"]
            .iter()
            .map(|each| each.to_string())
            .collect();
        let plan = plan_of(&inflight).expect("a plan in flight");
        assert_eq!(plan.close, Close::Target);
        assert!(plan.go && plan.reclaim);
        assert!(plan_of(&["--no-such".to_string()]).is_err());
        assert!(plan_of(&["--close".to_string(), "soon".to_string(), "h".to_string(), "1".to_string()]).is_err());
    }

    #[test]
    fn a_range_with_no_free_port_is_refused_with_its_name() {
        assert_eq!(errno_of(&std::io::Error::from_raw_os_error(libc::EADDRNOTAVAIL)), "EADDRNOTAVAIL");
    }

    #[test]
    fn the_control_connection_closes_with_a_reset_and_holds_no_port() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener");
        let stream = TcpStream::connect(listener.local_addr().expect("an address")).expect("a connect");
        abortive(&stream).expect("SO_LINGER");
        let mut linger = libc::linger { l_onoff: 0, l_linger: -1 };
        let mut size = std::mem::size_of::<libc::linger>() as libc::socklen_t;
        // SAFETY: the buffer is on this stack, passed with its exact size
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_LINGER,
                (&mut linger as *mut libc::linger).cast(),
                &mut size,
            )
        };
        assert_eq!(status, 0);
        assert_eq!((linger.l_onoff, linger.l_linger), (1, 0));
    }
}
