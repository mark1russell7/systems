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
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

const COUNT: &str = "/proc/sys/net/netfilter/nf_conntrack_count";
const NETSTAT: &str = "/proc/net/netstat";
/// the subsystem of ctnetlink in nfnetlink (`NFNL_SUBSYS_CTNETLINK`)
const CTNETLINK: u16 = 1;
/// the message of ctnetlink that dumps the statistics of each CPU (`IPCTNL_MSG_CT_GET_STATS_CPU`)
const GET_STATS_CPU: u16 = 4;
/// the attribute of the field drop in each message of that dump (`CTA_STATS_DROP`), a big-endian u32
const STATS_DROP: u16 = 10;
/// the length of the header of a netlink message, and of the header of nfnetlink after it
const NLMSG_HEADER: usize = 16;
const NFGENMSG: usize = 4;
/// the type bits of an attribute, without the flags of nesting and byte order
const ATTRIBUTE_TYPE: u16 = 0x3fff;
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

/// Gives the request of the dump of the conntrack statistics of each CPU: a netlink header, then a nfnetlink header.
fn stats_request(seq: u32) -> Vec<u8> {
    let length = (NLMSG_HEADER + NFGENMSG) as u32;
    let mut message = Vec::with_capacity(NLMSG_HEADER + NFGENMSG);
    message.extend_from_slice(&length.to_ne_bytes());
    message.extend_from_slice(&((CTNETLINK << 8) | GET_STATS_CPU).to_ne_bytes());
    message.extend_from_slice(&((libc::NLM_F_REQUEST | libc::NLM_F_DUMP) as u16).to_ne_bytes());
    message.extend_from_slice(&seq.to_ne_bytes());
    message.extend_from_slice(&0u32.to_ne_bytes());
    // the family AF_UNSPEC, the version NFNETLINK_V0, and the resource 0
    message.extend_from_slice(&[0, 0, 0, 0]);
    message
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_ne_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Netlink pads each message and each attribute to four bytes.
fn aligned(length: usize) -> usize {
    (length + 3) & !3
}

/// Gives the field drop of the attributes of one message of the dump.
fn drop_of(attributes: &[u8]) -> Result<u64, String> {
    let mut at = 0;
    while at + 4 <= attributes.len() {
        let length = usize::from(u16_at(attributes, at).ok_or("a short attribute")?);
        let kind = u16_at(attributes, at + 2).ok_or("a short attribute")? & ATTRIBUTE_TYPE;
        if length < 4 || at + length > attributes.len() {
            return Err(format!("an attribute of {length} bytes at byte {at} of {}", attributes.len()));
        }
        if kind == STATS_DROP {
            let value = attributes.get(at + 4..at + 8).ok_or("a short field drop")?;
            return Ok(u64::from(u32::from_be_bytes(value.try_into().map_err(|_| "a short field drop")?)));
        }
        at += aligned(length);
    }
    Err("a message of the statistics with no field drop".into())
}

/// What one datagram of the dump gave: the sum of the field drop of its messages, and whether the dump ended.
#[derive(Debug, PartialEq)]
struct Part {
    drops: u64,
    done: bool,
}

/// Reads one datagram of the dump: messages of the statistics of a CPU, an error, or the end of the dump.
fn stats_part(datagram: &[u8]) -> Result<Part, String> {
    let mut drops = 0;
    let mut at = 0;
    while at + NLMSG_HEADER <= datagram.len() {
        let length = u32_at(datagram, at).ok_or("a short header")? as usize;
        let kind = u16_at(datagram, at + 4).ok_or("a short header")?;
        if length < NLMSG_HEADER || at + length > datagram.len() {
            return Err(format!("a message of {length} bytes at byte {at} of {}", datagram.len()));
        }
        let message = &datagram[at..at + length];
        if i32::from(kind) == libc::NLMSG_DONE {
            return Ok(Part { drops, done: true });
        }
        if i32::from(kind) == libc::NLMSG_ERROR {
            let code = i32::from_ne_bytes(message.get(NLMSG_HEADER..NLMSG_HEADER + 4).ok_or("a short error")?.try_into().map_err(|_| "a short error")?);
            if code != 0 {
                return Err(std::io::Error::from_raw_os_error(-code).to_string());
            }
        } else if kind == (CTNETLINK << 8) | GET_STATS_CPU {
            drops += drop_of(message.get(NLMSG_HEADER + NFGENMSG..).ok_or("a message with no nfnetlink header")?)?;
        }
        at += aligned(length);
    }
    Ok(Part { drops, done: false })
}

fn os_error(what: &str) -> String {
    format!("{what}: {}", std::io::Error::last_os_error())
}

/// Reads the sum of the field drop of the conntrack statistics of this namespace over ctnetlink. A kernel
/// without CONFIG_NF_CONNTRACK_PROCFS has no /proc/net/stat/nf_conntrack, and the kernel of the runners is
/// such a kernel. Each message of nfnetlink needs NET_ADMIN in the namespace.
fn stat_drops() -> Result<u64, String> {
    // SAFETY: the call takes no pointer
    let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, libc::NETLINK_NETFILTER) };
    if fd < 0 {
        return Err(os_error("no netlink socket"));
    }
    // SAFETY: the descriptor is new, and only this owner closes it
    let socket = unsafe { OwnedFd::from_raw_fd(fd) };
    // the kernel answers each request, and this limit stops a wait that does not end
    let limit = libc::timeval { tv_sec: 5, tv_usec: 0 };
    // SAFETY: the option value is on this stack, passed with its exact size
    let status = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            (&limit as *const libc::timeval).cast(),
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        )
    };
    if status != 0 {
        return Err(os_error("no limit on the netlink socket"));
    }
    let request = stats_request(1);
    // SAFETY: the buffer is the request, passed with its exact size. An unconnected netlink socket sends to the kernel
    if unsafe { libc::send(socket.as_raw_fd(), request.as_ptr().cast(), request.len(), 0) } < 0 {
        return Err(os_error("the request did not go"));
    }
    let mut buffer = vec![0u8; 65_536];
    let mut total = 0;
    loop {
        // SAFETY: the call writes at most the length of the buffer into it
        let got = unsafe { libc::recv(socket.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len(), 0) };
        if got < 0 {
            return Err(os_error("no answer to the request"));
        }
        if got == 0 {
            return Err("the dump ended with no NLMSG_DONE".into());
        }
        let part = stats_part(&buffer[..got as usize])?;
        total += part.drops;
        if part.done {
            return Ok(total);
        }
    }
}

/// Gives one counter of the TcpExt lines of /proc/net/netstat: a line of names, then a line of values.
fn tcp_ext(text: &str, field: &str) -> Option<u64> {
    let mut rows = text.lines().filter(|line| line.starts_with("TcpExt:"));
    let at = rows.next()?.split_whitespace().position(|name| name == field)?;
    rows.next()?.split_whitespace().nth(at)?.parse().ok()
}

/// Reads the two counters of a stalled connect: the entries that the table refused, and the sends that failed.
fn counters() -> Result<(u64, u64), Box<dyn Error>> {
    let drops = stat_drops().map_err(|error| format!("no conntrack statistics over netlink: {error}"))?;
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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("target") => target(&args[1..]),
        Some("client") => client(&args[1..]),
        _ => Err("ctfull target PORT [--fill M] | ctfull client [flags] HOST PORT".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // the harness reads the lines of this program, thus a run with no end names its cause
            emit("error", json!({ "what": error.to_string() }));
            eprintln!("{error}");
            ExitCode::FAILURE
        }
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

    fn message(kind: u16, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((NLMSG_HEADER + payload.len()) as u32).to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(&0u16.to_ne_bytes());
        bytes.extend_from_slice(&1u32.to_ne_bytes());
        bytes.extend_from_slice(&0u32.to_ne_bytes());
        bytes.extend_from_slice(payload);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn attribute(kind: u16, value: u32) -> Vec<u8> {
        [8u16.to_ne_bytes().as_slice(), &kind.to_ne_bytes(), &value.to_be_bytes()].concat()
    }

    /// One message of the dump: the nfnetlink header with the CPU, then the fields found, drop and early_drop.
    fn stats(cpu: u16, drop: u32) -> Vec<u8> {
        let payload = [vec![0, 0], cpu.to_be_bytes().to_vec(), attribute(2, 99), attribute(STATS_DROP, drop), attribute(11, 5)].concat();
        message((CTNETLINK << 8) | GET_STATS_CPU, &payload)
    }

    #[test]
    fn the_request_dumps_the_statistics_of_each_cpu() {
        let request = stats_request(7);
        assert_eq!(request.len(), 20);
        assert_eq!(u32_at(&request, 0), Some(20));
        assert_eq!(u16_at(&request, 4), Some(0x0104));
        assert_eq!(u16_at(&request, 6), Some(0x0301));
        assert_eq!(u32_at(&request, 8), Some(7));
        assert_eq!(&request[16..], &[0, 0, 0, 0]);
    }

    #[test]
    fn the_dump_sums_the_field_drop_of_each_cpu_until_its_end() {
        let done = message(libc::NLMSG_DONE as u16, &0i32.to_ne_bytes());
        assert_eq!(stats_part(&[stats(0, 10), stats(1, 6), done].concat()), Ok(Part { drops: 16, done: true }));
        assert_eq!(stats_part(&stats(3, 4)), Ok(Part { drops: 4, done: false }));
        let refused = message(libc::NLMSG_ERROR as u16, &[(-libc::EPERM).to_ne_bytes().as_slice(), &stats_request(1)[..16]].concat());
        assert_eq!(stats_part(&refused), Err(std::io::Error::from_raw_os_error(libc::EPERM).to_string()));
        let acked = message(libc::NLMSG_ERROR as u16, &[0i32.to_ne_bytes().as_slice(), &stats_request(1)[..16]].concat());
        assert_eq!(stats_part(&acked), Ok(Part { drops: 0, done: false }));
        let mut short = stats(0, 10);
        short.truncate(30);
        assert!(stats_part(&short).is_err());
        let no_drop = message((CTNETLINK << 8) | GET_STATS_CPU, &[vec![0, 0, 0, 0], attribute(2, 99)].concat());
        assert_eq!(stats_part(&no_drop), Err("a message of the statistics with no field drop".to_string()));
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
