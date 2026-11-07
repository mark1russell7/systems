//! load HOST PORT --plan PATH [--go PATH] [--sample-ms N] [--max-s N]
//!
//! An open-loop driver of an HTTP/1.1 server. Each event is a JSON line stamped on CLOCK_MONOTONIC.
//! The file --plan has the format systems-load/1: a list of streams. Each stream has a key, a
//! schedule of the format rigor-schedule/1 and a list of requests. Arrival i of a stream sends request i modulo
//! the length of the list. Each request is the whole text of an HTTP/1.1 request.
//!
//! Each stream has its own connection, thus a slow reply delays only the arrivals of its own stream.
//! One shared connection gives each request the queue of all the requests before it. Then a heavy
//! stream moves each other stream, and the noise of one tenant on the others cannot be measured.
//!
//! The driver opens each connection and writes ready. Then it waits for the file --go. Then it
//! sends each arrival at its time, and a send does not wait for a reply (coordinated omission).
//! The requests of a stream share its connection, and the replies come in their order. The lines
//! sent and replied name the stream (k) and the arrival (i), and a replied line names the status.
//! It ends with a done line when each connection has each reply or has ended. An error, an end or
//! the deadline leaves the rest without a reply.

use harness_native::{arrivals_in, emit, emit_at};
use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::error::Error;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::Duration;

/// The longest head of a response that the driver reads: more is an error of the server.
const HEAD_LIMIT: usize = 65_536;

/// One stream of a plan: its key, its arrivals in ns from the start, and its requests.
struct Stream {
    key: String,
    times: Vec<u64>,
    requests: Vec<Vec<u8>>,
}

/// The streams of a file of the format systems-load/1.
fn plan_of(text: &str) -> Result<Vec<Stream>, Box<dyn Error>> {
    let plan: Value = serde_json::from_str(text)?;
    if plan["format"] != "systems-load/1" {
        return Err(format!("the plan has the format {}, not systems-load/1", plan["format"]).into());
    }
    let streams = plan["streams"].as_array().ok_or("the plan has no list of streams")?;
    if streams.is_empty() {
        return Err("the plan has no stream".into());
    }
    let mut keys = std::collections::HashSet::new();
    streams
        .iter()
        .map(|stream| -> Result<Stream, Box<dyn Error>> {
            let key = stream["key"].as_str().ok_or("a stream has no key")?.to_string();
            if !keys.insert(key.clone()) {
                return Err(format!("two streams have the key {key}").into());
            }
            let times = arrivals_in(&stream["schedule"])?;
            let requests = stream["requests"]
                .as_array()
                .ok_or_else(|| format!("the stream {key} has no list of requests"))?
                .iter()
                .map(|request| request.as_str().map(|text| text.as_bytes().to_vec()).ok_or_else(|| format!("a request of the stream {key} is not text")))
                .collect::<Result<Vec<_>, String>>()?;
            if requests.is_empty() {
                return Err(format!("the stream {key} has no request").into());
            }
            Ok(Stream { key, times, requests })
        })
        .collect()
}

fn find(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes.windows(needle.len()).position(|window| window == needle)
}

/// The end of a chunked body that starts at `at`, or None while the body is not all there.
fn chunked_end(bytes: &[u8], mut at: usize) -> Result<Option<usize>, String> {
    loop {
        let Some(line) = find(&bytes[at..], b"\r\n") else { return Ok(None) };
        let text = std::str::from_utf8(&bytes[at..at + line]).map_err(|_| "a chunk size that is not UTF-8".to_string())?;
        let digits = text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(digits, 16).map_err(|_| format!("the chunk size {text:?}"))?;
        at += line + 2;
        if size == 0 {
            // the trailers, if any, end at an empty line
            if bytes.len() < at + 2 {
                return Ok(None);
            }
            if &bytes[at..at + 2] == b"\r\n" {
                return Ok(Some(at + 2));
            }
            return Ok(find(&bytes[at..], b"\r\n\r\n").map(|end| at + end + 4));
        }
        if bytes.len() < at + size + 2 {
            return Ok(None);
        }
        if &bytes[at + size..at + size + 2] != b"\r\n" {
            return Err("a chunk with no CRLF after it".into());
        }
        at += size + 2;
    }
}

/// The length and the status of the first response in `bytes`, or None while it is not all there.
/// A response has a Content-Length or a chunked body, or it has no body (204 and 304). A response
/// with no length ends only at the end of its connection, thus the driver refuses it.
fn response_length(bytes: &[u8]) -> Result<Option<(usize, u16)>, String> {
    let Some(end) = find(bytes, b"\r\n\r\n") else {
        return if bytes.len() > HEAD_LIMIT { Err(format!("a head of more than {HEAD_LIMIT} bytes")) } else { Ok(None) };
    };
    let head = std::str::from_utf8(&bytes[..end]).map_err(|_| "a head that is not UTF-8".to_string())?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let status = parts.next().and_then(|code| code.parse::<u16>().ok());
    let Some(status) = status.filter(|_| version.starts_with("HTTP/1.")) else {
        return Err(format!("the status line {status_line:?}"));
    };
    if status < 200 {
        return Err(format!("an interim response {status}: the driver sends no Expect and no Upgrade"));
    }
    let (mut length, mut chunked) = (None, false);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { return Err(format!("the header line {line:?}")) };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.parse::<usize>().map_err(|_| format!("the length {value:?}"))?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.split(',').any(|coding| coding.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    let body = end + 4;
    if status == 204 || status == 304 {
        return Ok(Some((body, status)));
    }
    if chunked {
        return Ok(chunked_end(bytes, body)?.map(|whole| (whole, status)));
    }
    match length {
        Some(length) => Ok((bytes.len() >= body + length).then_some((body + length, status))),
        None => Err(format!("a response of status {status} with no length")),
    }
}

/// One stream on its connection, and where it is in its schedule.
struct Connection {
    stream: Stream,
    socket: TcpStream,
    /// the next arrival to send, and the bytes of it already written
    next: usize,
    written: usize,
    answered: usize,
    /// the socket took no more bytes: the next write waits for POLLOUT
    blocked: bool,
    open: bool,
    /// the bytes received and not yet a whole response
    buffer: Vec<u8>,
}

impl Connection {
    fn open(host: &str, port: u16, stream: Stream) -> std::io::Result<Self> {
        let socket = TcpStream::connect((host, port))?;
        socket.set_nodelay(true)?;
        socket.set_nonblocking(true)?;
        Ok(Self { stream, socket, next: 0, written: 0, answered: 0, blocked: false, open: true, buffer: Vec::new() })
    }

    fn finished(&self) -> bool {
        !self.open || self.answered == self.stream.times.len()
    }

    fn fail(&mut self, out: &mut dyn FnMut(&str, u64, Value), error: &std::io::Error) {
        out("error", monotonic_ns(), json!({ "k": self.stream.key, "errno": errno_name(error.raw_os_error().unwrap_or(0)) }));
        self.open = false;
    }

    /// Writes each arrival that is due at `start`, until the socket takes no more.
    fn send_due(&mut self, start: u64, out: &mut dyn FnMut(&str, u64, Value)) {
        while self.open && !self.blocked && self.next < self.stream.times.len() && monotonic_ns() >= start + self.stream.times[self.next] {
            let request = &self.stream.requests[self.next % self.stream.requests.len()];
            let t = monotonic_ns();
            match self.socket.write(&request[self.written..]) {
                Ok(n) => {
                    self.written += n;
                    if self.written == request.len() {
                        out("sent", t, json!({ "k": self.stream.key, "i": self.next }));
                        self.next += 1;
                        self.written = 0;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => self.blocked = true,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    out("error", monotonic_ns(), json!({ "k": self.stream.key, "errno": errno_name(error.raw_os_error().unwrap_or(0)) }));
                    self.open = false;
                }
            }
        }
    }

    /// Reads what the socket holds, and gives a replied line for each whole response.
    fn receive(&mut self, buf: &mut [u8], out: &mut dyn FnMut(&str, u64, Value)) {
        while self.open {
            match self.socket.read(buf) {
                Ok(0) => {
                    out("eof", monotonic_ns(), json!({ "k": self.stream.key }));
                    self.open = false;
                }
                Ok(n) => {
                    let t = monotonic_ns();
                    self.buffer.extend_from_slice(&buf[..n]);
                    self.take_responses(t, out);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => self.fail(out, &error),
            }
        }
    }

    fn take_responses(&mut self, t: u64, out: &mut dyn FnMut(&str, u64, Value)) {
        loop {
            match response_length(&self.buffer) {
                Ok(None) => return,
                Ok(Some((length, status))) => {
                    self.buffer.drain(..length);
                    out("replied", t, json!({ "k": self.stream.key, "i": self.answered, "status": status }));
                    self.answered += 1;
                }
                Err(why) => {
                    out("error", t, json!({ "k": self.stream.key, "why": why }));
                    self.open = false;
                    return;
                }
            }
        }
    }
}

/// Waits up to `ns` for the open connections. A wait in ms is too coarse for a schedule, thus this
/// one is ppoll(). It gives the revents of each connection, 0 for one that is not open.
fn wait_for(connections: &[Connection], ns: u64) -> std::io::Result<Vec<i16>> {
    let mut polled: Vec<libc::pollfd> = connections
        .iter()
        .map(|connection| {
            let writing = if connection.blocked { libc::POLLOUT } else { 0 };
            // a negative fd is skipped by ppoll(), and its revents stay 0
            let fd = if connection.open { connection.socket.as_raw_fd() } else { -1 };
            libc::pollfd { fd, events: libc::POLLIN | libc::POLLRDHUP | writing, revents: 0 }
        })
        .collect();
    let time = libc::timespec { tv_sec: (ns / 1_000_000_000) as libc::time_t, tv_nsec: (ns % 1_000_000_000) as libc::c_long };
    // SAFETY: the pollfds and the timespec live on this frame, with their exact count, and no signal mask
    match unsafe { libc::ppoll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, &time, std::ptr::null()) } {
        -1 if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted => Ok(vec![0; connections.len()]),
        -1 => Err(std::io::Error::last_os_error()),
        _ => Ok(polled.iter().map(|entry| entry.revents).collect()),
    }
}

/// Runs the schedule of each connection from `start`, until each connection is finished or the
/// deadline passes. A wait is at most `tick` ns.
fn drive(connections: &mut [Connection], start: u64, deadline: u64, tick: u64, out: &mut dyn FnMut(&str, u64, Value)) -> Result<(), Box<dyn Error>> {
    let mut buf = vec![0u8; 65_536];
    loop {
        for connection in connections.iter_mut() {
            connection.send_due(start, out);
        }
        if connections.iter().all(Connection::finished) {
            let requests: usize = connections.iter().map(|connection| connection.next).sum();
            out("done", monotonic_ns(), json!({ "requests": requests }));
            return Ok(());
        }
        let now = monotonic_ns();
        if now > deadline {
            out("deadline", now, json!({}));
            return Ok(());
        }
        let due = connections
            .iter()
            .filter(|connection| connection.open && !connection.blocked)
            .filter_map(|connection| connection.stream.times.get(connection.next))
            .map(|at| (start + at).saturating_sub(now))
            .fold(tick, u64::min);
        let revents = wait_for(connections, due)?;
        for (connection, events) in connections.iter_mut().zip(revents) {
            if events & libc::POLLOUT != 0 {
                connection.blocked = false;
            }
            if events & !libc::POLLOUT != 0 {
                connection.receive(&mut buf, out);
            }
        }
    }
}

struct Args {
    host: String,
    port: u16,
    plan: String,
    go: String,
    sample: Duration,
    max: Duration,
}

fn args() -> Result<Args, Box<dyn Error>> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| raw.iter().position(|arg| arg == flag).and_then(|at| raw.get(at + 1)).cloned();
    Ok(Args {
        host: raw.first().ok_or("the target's host comes first")?.clone(),
        port: raw.get(1).ok_or("then its port")?.parse()?,
        plan: value("--plan").ok_or("--plan is required")?,
        go: value("--go").unwrap_or_else(|| "/tmp/go".into()),
        sample: Duration::from_micros((value("--sample-ms").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(2.0) * 1000.0) as u64),
        max: Duration::from_secs_f64(value("--max-s").map(|v| v.parse::<f64>()).transpose()?.unwrap_or(120.0)),
    })
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = args()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_string();
    let streams = plan_of(&std::fs::read_to_string(&args.plan)?)?;
    emit("start", json!({ "boot_id": boot_id, "mode": "load", "streams": streams.len() }));
    let deadline = monotonic_ns() + args.max.as_nanos() as u64;
    let mut connections = Vec::with_capacity(streams.len());
    for stream in streams {
        let key = stream.key.clone();
        connections.push(Connection::open(&args.host, args.port, stream)?);
        emit("connected", json!({ "k": key }));
    }
    emit("ready", json!({ "streams": connections.len() }));
    while !Path::new(&args.go).exists() {
        if monotonic_ns() > deadline {
            emit("deadline", json!({}));
            return Ok(());
        }
        std::thread::sleep(args.sample);
    }
    let start = monotonic_ns();
    let arrivals: usize = connections.iter().map(|connection| connection.stream.times.len()).sum();
    emit_at("scheduled", start, json!({ "streams": connections.len(), "arrivals": arrivals }));
    drive(&mut connections, start, deadline, args.sample.as_nanos() as u64, &mut |event, t, fields| emit_at(event, t, fields))
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
    use std::net::TcpListener;

    const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

    #[test]
    fn a_response_is_whole_after_its_length_or_its_last_chunk() {
        assert_eq!(response_length(OK), Ok(Some((40, 200))));
        assert_eq!(response_length(&OK[..39]), Ok(None));
        let empty = b"HTTP/1.1 204 No Content\r\nX: y\r\n\r\n";
        assert_eq!(response_length(empty), Ok(Some((empty.len(), 204))));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
        assert_eq!(response_length(chunked), Ok(Some((chunked.len(), 200))));
        for cut in 0..chunked.len() {
            assert_eq!(response_length(&chunked[..cut]), Ok(None), "cut at {cut}");
        }
        let trailers = b"HTTP/1.1 500 Error\r\ntransfer-encoding: chunked\r\n\r\n2;x=y\r\nab\r\n0\r\nT: 1\r\n\r\n";
        assert_eq!(response_length(trailers), Ok(Some((trailers.len(), 500))));
    }

    #[test]
    fn a_response_that_the_driver_cannot_frame_is_an_error() {
        assert!(response_length(b"HTTP/1.1 200 OK\r\n\r\nbody").is_err());
        assert!(response_length(b"HTTP/1.1 100 Continue\r\n\r\n").is_err());
        assert!(response_length(b"SPDY/3 200 OK\r\nContent-Length: 0\r\n\r\n").is_err());
        assert!(response_length(b"HTTP/1.1 200 OK\r\nContent-Length: x\r\n\r\n").is_err());
        assert!(response_length(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").is_err());
        assert!(response_length(&vec![b'a'; HEAD_LIMIT + 1]).is_err());
    }

    #[test]
    fn a_pipeline_of_responses_splits_at_each_end_in_reads_of_any_size() {
        let parts: [&[u8]; 4] = [OK, b"HTTP/1.1 204 No Content\r\n\r\n", b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n\r\n", OK];
        let bytes = parts.concat();
        for size in 1..bytes.len() {
            let (mut buffer, mut statuses) = (Vec::new(), Vec::new());
            for read in bytes.chunks(size) {
                buffer.extend_from_slice(read);
                while let Some((length, status)) = response_length(&buffer).unwrap() {
                    buffer.drain(..length);
                    statuses.push(status);
                }
            }
            assert_eq!(statuses, [200, 204, 200, 200], "reads of {size}");
            assert!(buffer.is_empty());
        }
    }

    #[test]
    fn a_plan_gives_its_streams_and_refuses_a_bad_one() {
        let schedule = r#"{"format":"rigor-schedule/1","times":[0,1.5]}"#;
        let plan = format!(r#"{{"format":"systems-load/1","streams":[{{"key":"t0","schedule":{schedule},"requests":["A","B"]}}]}}"#);
        let streams = plan_of(&plan).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].key, "t0");
        assert_eq!(streams[0].times, [0, 1_500_000]);
        assert_eq!(streams[0].requests, [b"A".to_vec(), b"B".to_vec()]);
        assert!(plan_of(r#"{"format":"other","streams":[]}"#).is_err());
        assert!(plan_of(r#"{"format":"systems-load/1","streams":[]}"#).is_err());
        let twice = format!(r#"{{"format":"systems-load/1","streams":[{{"key":"a","schedule":{schedule},"requests":["A"]}},{{"key":"a","schedule":{schedule},"requests":["A"]}}]}}"#);
        assert!(plan_of(&twice).is_err());
        let none = format!(r#"{{"format":"systems-load/1","streams":[{{"key":"a","schedule":{schedule},"requests":[]}}]}}"#);
        assert!(plan_of(&none).is_err());
    }

    /// A server that answers each request of each connection with OK, after `delay` for the key `slow`.
    fn serve(connections: usize, slow: Duration) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for socket in listener.incoming().take(connections) {
                let mut socket = socket.unwrap();
                std::thread::spawn(move || {
                    let (mut buffer, mut buf) = (Vec::new(), [0u8; 4096]);
                    while let Ok(n) = socket.read(&mut buf) {
                        if n == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&buf[..n]);
                        while let Some(end) = find(&buffer, b"\r\n\r\n") {
                            let request: Vec<u8> = buffer.drain(..end + 4).collect();
                            if find(&request, b"slow").is_some() {
                                std::thread::sleep(slow);
                            }
                            if socket.write_all(OK).is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        port
    }

    fn stream(key: &str, times: &[u64]) -> Stream {
        let request = format!("GET /{key} HTTP/1.1\r\nHost: t\r\n\r\n");
        Stream { key: key.into(), times: times.to_vec(), requests: vec![request.into_bytes()] }
    }

    #[test]
    fn each_stream_gets_each_reply_and_a_slow_stream_delays_only_itself() {
        let port = serve(2, Duration::from_millis(200));
        let ms = 1_000_000;
        let mut connections = vec![
            Connection::open("127.0.0.1", port, stream("slow", &[0, ms, 2 * ms])).unwrap(),
            Connection::open("127.0.0.1", port, stream("fast", &[0, ms, 2 * ms])).unwrap(),
        ];
        let mut events: Vec<(String, u64, Value)> = Vec::new();
        let start = monotonic_ns();
        let deadline = start + 10_000 * ms;
        drive(&mut connections, start, deadline, ms, &mut |event, t, fields| events.push((event.into(), t, fields))).unwrap();
        let replied = |key: &str| -> Vec<u64> {
            events.iter().filter(|(event, _, fields)| event == "replied" && fields["k"] == key).map(|(_, t, _)| t - start).collect()
        };
        assert_eq!(replied("slow").len(), 3);
        assert_eq!(replied("fast").len(), 3);
        assert!(events.iter().filter(|(event, _, _)| event == "replied").all(|(_, _, fields)| fields["status"] == 200));
        // the last reply of the fast stream comes before the first of the slow one
        assert!(replied("fast")[2] < replied("slow")[0], "{events:?}");
        let sent = events.iter().filter(|(event, _, _)| event == "sent").count();
        assert_eq!(sent, 6);
        assert_eq!(events.last().map(|(event, _, fields)| (event.as_str(), fields["requests"].clone())), Some(("done", json!(6))));
    }
}
