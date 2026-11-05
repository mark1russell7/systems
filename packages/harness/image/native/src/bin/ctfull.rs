//! ctfull target PORT [--fill M]
//! ctfull client --max M --plan full|reset|fin [--settle-s N] HOST PORT [--mode M] [--max-s N]
//!
//! This program is the two ends of the conntrack cells. Each line is JSON with an `ev` and a `t` on
//! CLOCK_MONOTONIC. The client makes its flows on loopback, thus each flow is one entry of the table
//! of its own network namespace, and no entry goes to the table of the host.
//!
//! The target listens on PORT. With `--fill M`, it holds M flows on its own loopback, so that its
//! namespace reads M, and it writes a `count` line each second. It reads its count after each connect,
//! because the rule that starts conntrack in the namespace can come after its start. A flow that does
//! not raise the count closes with a reset.
//!
//! The client does these steps:
//!
//! 1. It writes `ready`, and it waits until the count of its namespace is 0: the entries of the run
//!    before it go at a scan. It writes `settled`, or `unsettled` at the end of `--settle-s`.
//! 2. It holds M flows, and it writes `full`. Then it waits, so that the last flow is assured.
//! 3. `--plan full` makes connect M + 1, and it writes `stall` with its errno, its time and the
//!    rise of the two counters of the kernel. It then closes each flow with a reset.
//! 4. `--plan reset` writes `closing`, closes each flow with a reset, and writes `drained` when the
//!    count is 0 or at the end of the wait: the first fall, the zero and the lowest count, from a
//!    poll of 1 ms.
//! 5. `--plan fin` closes each flow with a FIN from each side, and it writes `closed` with the count.
//!    It makes connect M + 1 with the poll on, and it writes `stall` with the lowest count and the
//!    count after the connect.

use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::error::Error;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

const COUNT: &str = "/proc/sys/net/netfilter/nf_conntrack_count";
const STATS: &str = "/proc/net/stat/nf_conntrack";
const NETSTAT: &str = "/proc/net/netstat";
/// the wait after the last flow of a fill and after each side closes, in milliseconds
const SETTLE_MS: u64 = 50;
/// the time between two reads of the count while a step waits for it, in milliseconds
const WAIT_MS: u64 = 100;
/// the longest wait for the count to reach 0 after a reset, in seconds: 10 s and one scan of 60 s, with a margin
const DRAIN_S: u64 = 90;
const SECOND_NS: u64 = 1_000_000_000;

fn emit(event: &str, fields: Value) {
    let mut line = json!({ "ev": event, "t": monotonic_ns() });
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    println!("{line}");
}

fn sleep_ms(time: u64) {
    std::thread::sleep(Duration::from_millis(time));
}

fn locked(held: &Mutex<Vec<TcpStream>>) -> MutexGuard<'_, Vec<TcpStream>> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Raises the soft limit of open files to the hard limit: a full table holds two sockets for each flow.
fn raise_files() -> std::io::Result<()> {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: the record is on this stack, and the call writes only that record
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    limit.rlim_cur = limit.rlim_max;
    // SAFETY: the record is on this stack, and the call only reads it
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Reads the count of the table of this namespace.
fn count() -> Result<u64, Box<dyn Error>> {
    Ok(std::fs::read_to_string(COUNT)?.trim().parse()?)
}

/// Gives the sum of one field of the conntrack statistics: a header line, then one hexadecimal line for each CPU.
fn stat_field(text: &str, field: &str) -> Option<u64> {
    let mut lines = text.lines();
    let at = lines.next()?.split_whitespace().position(|name| name == field)?;
    let mut total = 0;
    for line in lines {
        total += u64::from_str_radix(line.split_whitespace().nth(at)?, 16).ok()?;
    }
    Some(total)
}

/// Gives one counter of the TcpExt lines of /proc/net/netstat: a line of names, then a line of values.
fn tcp_ext(text: &str, field: &str) -> Option<u64> {
    let mut rows = text.lines().filter(|line| line.starts_with("TcpExt:"));
    let at = rows.next()?.split_whitespace().position(|name| name == field)?;
    rows.next()?.split_whitespace().nth(at)?.parse().ok()
}

/// Reads the two counters of a stalled connect: the entries that the table refused, and the sends that failed.
fn counters() -> Result<(u64, u64), Box<dyn Error>> {
    let drops = stat_field(&std::fs::read_to_string(STATS)?, "drop").ok_or("no field drop in the conntrack statistics")?;
    let failed = tcp_ext(&std::fs::read_to_string(NETSTAT)?, "TCPRetransFail").ok_or("no TCPRetransFail in netstat")?;
    Ok((drops, failed))
}

/// Closes a connection with a reset: SO_LINGER with a time of 0, then close(2).
fn reset(stream: TcpStream) -> std::io::Result<()> {
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

/// Accepts each connection of a listener on its own thread, and holds it.
fn hold_accepted(listener: TcpListener) -> Arc<Mutex<Vec<TcpStream>>> {
    let accepted = Arc::new(Mutex::new(Vec::new()));
    let held = Arc::clone(&accepted);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            locked(&held).push(stream);
        }
    });
    accepted
}

/// Holds flows on the loopback of the target until its namespace reads `max`. It never connects at `max`.
fn fill_neighbor(address: SocketAddr, max: u64, held: &mut Vec<TcpStream>) -> Result<(), Box<dyn Error>> {
    loop {
        let before = count()?;
        if before >= max {
            return Ok(());
        }
        let stream = TcpStream::connect(address)?;
        if count()? > before {
            held.push(stream);
        } else {
            // the rule of the namespace is not in yet, and this flow has no entry
            reset(stream)?;
            sleep_ms(WAIT_MS);
        }
    }
}

fn target(args: &[String]) -> Result<(), Box<dyn Error>> {
    let port: u16 = args.first().ok_or("ctfull target PORT [--fill M]")?.parse()?;
    let fill: Option<u64> = match args.get(1).map(String::as_str) {
        None => None,
        Some("--fill") => Some(args.get(2).ok_or("--fill needs a value")?.parse()?),
        Some(other) => return Err(format!("no flag {other}").into()),
    };
    raise_files()?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))?;
    let _accepted = hold_accepted(listener);
    emit("listening", json!({}));
    let mut held = Vec::new();
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    loop {
        if let Some(max) = fill {
            fill_neighbor(address, max, &mut held)?;
            emit("count", json!({ "count": count()?, "flows": held.len() }));
        }
        sleep_ms(1_000);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Way {
    Full,
    Reset,
    Fin,
}

#[derive(Debug)]
struct Plan {
    max: usize,
    way: Way,
    settle_s: u64,
}

fn plan_of(args: &[String]) -> Result<Plan, Box<dyn Error>> {
    let mut max: Option<usize> = None;
    let mut way = None;
    let mut settle_s: u64 = 200;
    let mut places = 0;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--max" => max = Some(value()?.parse()?),
            "--plan" => {
                way = Some(match value()?.as_str() {
                    "full" => Way::Full,
                    "reset" => Way::Reset,
                    "fin" => Way::Fin,
                    other => return Err(format!("no plan named {other}").into()),
                })
            }
            "--settle-s" => settle_s = value()?.parse()?,
            // the harness gives these flags to each client, and the plan does not read them
            "--mode" | "--max-s" => {
                value()?;
            }
            other if other.starts_with("--") => return Err(format!("no flag {other}").into()),
            // the host and the port of the target: the flows of the client stay on its loopback
            _ => places += 1,
        }
    }
    match (max, way, places) {
        (Some(max), Some(way), 2) => Ok(Plan { max, way, settle_s }),
        _ => Err("ctfull client --max M --plan full|reset|fin [--settle-s N] HOST PORT".into()),
    }
}

/// Waits until the count of the namespace is 0. It says if the count got there.
fn settled(wait_s: u64) -> Result<bool, Box<dyn Error>> {
    let start = monotonic_ns();
    loop {
        let now = count()?;
        let waited = monotonic_ns() - start;
        if now == 0 {
            emit("settled", json!({ "waited": waited }));
            return Ok(true);
        }
        if waited > wait_s * SECOND_NS {
            emit("unsettled", json!({ "count": now, "waited": waited }));
            return Ok(false);
        }
        sleep_ms(WAIT_MS);
    }
}

/// what a poll of the count saw
#[derive(Clone, Copy, Debug, PartialEq)]
struct Seen {
    first_fall: Option<u64>,
    zero: Option<u64>,
    lowest: u64,
}

impl Seen {
    fn new(level: u64) -> Self {
        Seen { first_fall: None, zero: None, lowest: level }
    }

    fn read(&mut self, level: u64, at: u64, now: u64) {
        if now < level && self.first_fall.is_none() {
            self.first_fall = Some(at);
        }
        if now == 0 && self.zero.is_none() {
            self.zero = Some(at);
        }
        self.lowest = self.lowest.min(now);
    }
}

/// Reads the count each millisecond, until `stop` or the count of 0.
fn poll(level: u64, stop: Arc<AtomicBool>) -> JoinHandle<Result<Seen, String>> {
    std::thread::spawn(move || {
        let mut seen = Seen::new(level);
        while !stop.load(Ordering::Relaxed) && seen.zero.is_none() {
            let now = count().map_err(|error| error.to_string())?;
            seen.read(level, monotonic_ns(), now);
            sleep_ms(1);
        }
        Ok(seen)
    })
}

fn seen_of(watch: JoinHandle<Result<Seen, String>>) -> Result<Seen, Box<dyn Error>> {
    Ok(watch.join().map_err(|_| "the poll of the count stopped")??)
}

/// Makes connect M + 1 and gives the line of its end, with the rise of the two counters.
fn stalled_connect(address: SocketAddr) -> Result<(Value, Option<TcpStream>), Box<dyn Error>> {
    let (drops, failed) = counters()?;
    let start = monotonic_ns();
    let result = TcpStream::connect(address);
    let elapsed = monotonic_ns() - start;
    let (drops_after, failed_after) = counters()?;
    let (errno, stream) = match result {
        Ok(stream) => ("none".to_string(), Some(stream)),
        Err(error) => (errno_of(&error), None),
    };
    let line = json!({
        "errno": errno,
        "elapsed": elapsed,
        "drops": drops_after - drops,
        "retrans_fail": failed_after - failed,
    });
    Ok((line, stream))
}

fn extend(line: Value, more: Value) -> Value {
    let mut joined = line;
    if let (Some(joined), Value::Object(more)) = (joined.as_object_mut(), more) {
        joined.extend(more);
    }
    joined
}

fn reset_all(streams: Vec<TcpStream>) -> std::io::Result<()> {
    for stream in streams {
        reset(stream)?;
    }
    Ok(())
}

fn client(args: &[String]) -> Result<(), Box<dyn Error>> {
    let plan = plan_of(args)?;
    raise_files()?;
    emit("ready", json!({}));
    if !settled(plan.settle_s)? {
        return Ok(());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let address = listener.local_addr()?;
    let accepted = hold_accepted(listener);
    let mut held = Vec::with_capacity(plan.max);
    let mut failed = None;
    while held.len() < plan.max {
        match TcpStream::connect(address) {
            Ok(stream) => held.push(stream),
            Err(error) => {
                failed = Some(errno_of(&error));
                break;
            }
        }
    }
    let level = count()?;
    emit("full", json!({ "flows": held.len(), "count": level, "errno": failed }));
    if failed.is_some() {
        reset_all(held)?;
        emit("done", json!({}));
        return Ok(());
    }
    sleep_ms(SETTLE_MS);
    match plan.way {
        Way::Full => {
            let (line, stream) = stalled_connect(address)?;
            emit("stall", line);
            held.extend(stream);
            reset_all(held)?;
        }
        Way::Reset => {
            let stop = Arc::new(AtomicBool::new(false));
            emit("closing", json!({}));
            reset_all(held)?;
            let watch = poll(level, Arc::clone(&stop));
            let end = monotonic_ns() + DRAIN_S * SECOND_NS;
            while !watch.is_finished() && monotonic_ns() < end {
                sleep_ms(WAIT_MS);
            }
            stop.store(true, Ordering::Relaxed);
            let seen = seen_of(watch)?;
            emit("drained", json!({ "first_fall": seen.first_fall, "zero": seen.zero, "lowest": seen.lowest }));
        }
        Way::Fin => {
            drop(held);
            sleep_ms(SETTLE_MS);
            locked(&accepted).clear();
            sleep_ms(SETTLE_MS);
            let closed = count()?;
            emit("closed", json!({ "count": closed }));
            let stop = Arc::new(AtomicBool::new(false));
            let watch = poll(closed, Arc::clone(&stop));
            let (line, stream) = stalled_connect(address)?;
            stop.store(true, Ordering::Relaxed);
            let seen = seen_of(watch)?;
            let after = count()?;
            emit("stall", extend(line, json!({ "lowest": seen.lowest, "after": after })));
            if let Some(stream) = stream {
                reset(stream)?;
            }
        }
    }
    emit("done", json!({}));
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("target") => target(&args[1..]),
        Some("client") => client(&args[1..]),
        _ => Err("ctfull target PORT [--fill M] | ctfull client [flags] HOST PORT".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|each| each.to_string()).collect()
    }

    #[test]
    fn a_plan_reads_its_flags_and_skips_the_flags_of_the_harness() {
        let args = strings(&["--max", "1024", "--plan", "fin", "--settle-s", "70", "10.0.0.2", "6392", "--mode", "idle", "--max-s", "90"]);
        let plan = plan_of(&args).expect("a plan");
        assert_eq!(plan.max, 1024);
        assert_eq!(plan.way, Way::Fin);
        assert_eq!(plan.settle_s, 70);
        assert!(plan_of(&strings(&["--no-such"])).is_err());
        assert!(plan_of(&strings(&["--max", "4", "h", "1"])).is_err());
        assert!(plan_of(&strings(&["--max", "4", "--plan", "soon", "h", "1"])).is_err());
    }

    #[test]
    fn the_statistics_sum_one_field_of_each_cpu_in_hexadecimal() {
        let text = "entries clashres found drop\n00000400 00000000 00000001 0000000a\n00000400 00000000 00000002 00000006\n";
        assert_eq!(stat_field(text, "drop"), Some(16));
        assert_eq!(stat_field(text, "found"), Some(3));
        assert_eq!(stat_field(text, "absent"), None);
    }

    #[test]
    fn a_counter_of_netstat_comes_from_the_second_tcpext_line() {
        let text = "TcpExt: SyncookiesSent TCPRetransFail\nTcpExt: 3 6\nIpExt: InNoRoutes\nIpExt: 0\n";
        assert_eq!(tcp_ext(text, "TCPRetransFail"), Some(6));
        assert_eq!(tcp_ext(text, "InNoRoutes"), None);
    }

    #[test]
    fn a_poll_keeps_the_first_fall_the_zero_and_the_lowest() {
        let mut seen = Seen::new(4);
        seen.read(4, 10, 4);
        assert_eq!(seen, Seen { first_fall: None, zero: None, lowest: 4 });
        seen.read(4, 20, 3);
        seen.read(4, 30, 4);
        seen.read(4, 40, 0);
        seen.read(4, 50, 0);
        assert_eq!(seen, Seen { first_fall: Some(20), zero: Some(40), lowest: 0 });
    }

    #[test]
    fn a_table_with_no_room_stalls_with_its_name() {
        assert_eq!(errno_of(&std::io::Error::from_raw_os_error(libc::ETIMEDOUT)), "ETIMEDOUT");
    }
}
