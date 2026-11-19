//! load HOST PORT --plan PATH [--go PATH] [--sample-ms N] [--max-s N]
//!
//! An open-loop driver of an HTTP/1.1 server. Each event is a JSON line stamped on CLOCK_MONOTONIC.
//! The file --plan has the format systems-load/1: a list of streams. Each stream has a key, a
//! schedule of the format rigor-schedule/1 and a list of requests. Arrival i of a stream sends request i modulo
//! the length of the list. Each request is the whole text of an HTTP/1.1 request.
//!
//! Each stream has its own connections, thus a slow reply delays only the arrivals of its own stream.
//! One shared connection gives each request the queue of all the requests before it. Then a heavy
//! stream moves each other stream, and the noise of one tenant on the others cannot be measured.
//!
//! The field connections of a stream sets how its arrivals go to the server:
//! - {"mode":"pipeline"} is the default. The stream has one connection. Each arrival goes at its
//!   time, also when the replies before it are not in (HTTP/1.1 pipelining). The replies come in
//!   the order of the requests.
//! - {"mode":"pool","size":n}: the stream keeps n connections, each with one request in flight at
//!   most. A due arrival takes the connection that is idle for the longest time. With no idle
//!   connection, it waits in the queue of its stream, in the order of the schedule. A connection
//!   that ends leaves the pool, and the driver does not open it again.
//! - {"mode":"fresh"}: each arrival gets a new connection. The connect starts at the planned time
//!   and does not block the other streams. The request goes when the connect is done, and the
//!   driver closes the connection after the reply. A failed connect is an error of that arrival only.
//!
//! A fresh stream leaves each closed connection in TIME_WAIT on the client, thus a high rate can use
//! all the local ports. A pool needs a keep-alive time of the server above the idle time of each
//! connection, else the server closes connections and the pool gets smaller.
//!
//! The driver opens each connection of each pipeline and each pool, and writes ready. Then it waits
//! for the file --go. Then it sends each arrival at its time, and a send does not wait for a reply
//! (coordinated omission). The lines sent and replied name the stream (k) and the arrival (i), and a
//! replied line names the status. In a pool and in a fresh stream, the replies can come out of
//! order: each replied line names the arrival of its own connection. There, a sent line also gives
//! the time that the arrival waited for its connection, in ns (wait): for an idle connection of the
//! pool, or for the connect. That wait is not a lag of the driver. It ends with a done line when each
//! stream has each reply or can send no more. An error, an end or the deadline leaves the rest
//! without a reply.

use harness_native::{arrivals_in, emit, emit_at};
use prober::{errno_name, monotonic_ns};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::error::Error;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::Path;
use std::time::Duration;

/// The longest head of a response that the driver reads: more is an error of the server.
const HEAD_LIMIT: usize = 65_536;

/// The most connections of the pool of one stream.
const POOL_LIMIT: u64 = 1024;

/// How a stream sends its arrivals to the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// one connection, and each arrival goes at its time while the replies before it are not in
    Pipeline,
    /// this count of kept connections, each with one request in flight at most
    Pool(usize),
    /// a new connection for each arrival, closed after its reply
    Fresh,
}

/// One stream of a plan: its key, its arrivals in ns from the start, its requests and its mode.
struct Stream {
    key: String,
    times: Vec<u64>,
    requests: Vec<Vec<u8>>,
    mode: Mode,
}

/// The mode of the field connections of the stream `key`. A stream with no such field is a pipeline.
fn mode_of(key: &str, connections: &Value) -> Result<Mode, String> {
    if connections.is_null() {
        return Ok(Mode::Pipeline);
    }
    match connections["mode"].as_str() {
        Some("pipeline") => Ok(Mode::Pipeline),
        Some("fresh") => Ok(Mode::Fresh),
        Some("pool") => match connections["size"].as_u64() {
            Some(size) if (1..=POOL_LIMIT).contains(&size) => Ok(Mode::Pool(size as usize)),
            _ => Err(format!("the pool of the stream {key} has the size {}: a whole number from 1 to {POOL_LIMIT}", connections["size"])),
        },
        _ => Err(format!("the stream {key} has the connections {connections}: the mode is pipeline, pool or fresh")),
    }
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
            let mode = mode_of(&key, &stream["connections"])?;
            Ok(Stream { key, times, requests, mode })
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

/// The sink of the lines of the driver: the event, its stamp on CLOCK_MONOTONIC, and its fields.
type Out<'a> = &'a mut dyn FnMut(&str, u64, Value);

/// The name of the errno of an error, or of 0 for an error with no errno.
fn errno_of(error: &std::io::Error) -> String {
    errno_name(error.raw_os_error().unwrap_or(0))
}

/// One stream on its connection in the mode pipeline, and where it is in its schedule.
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
    fn open(address: SocketAddr, stream: Stream) -> std::io::Result<Self> {
        let socket = TcpStream::connect(address)?;
        socket.set_nodelay(true)?;
        socket.set_nonblocking(true)?;
        Ok(Self { stream, socket, next: 0, written: 0, answered: 0, blocked: false, open: true, buffer: Vec::new() })
    }

    fn finished(&self) -> bool {
        !self.open || self.answered == self.stream.times.len()
    }

    fn fail(&mut self, out: Out<'_>, error: &std::io::Error) {
        out("error", monotonic_ns(), json!({ "k": self.stream.key, "errno": errno_of(error) }));
        self.open = false;
    }

    /// Writes each arrival that is due at `start`, until the socket takes no more.
    fn send_due(&mut self, start: u64, out: Out<'_>) {
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
                    out("error", monotonic_ns(), json!({ "k": self.stream.key, "errno": errno_of(&error) }));
                    self.open = false;
                }
            }
        }
    }

    /// Reads what the socket holds, and gives a replied line for each whole response.
    fn receive(&mut self, buf: &mut [u8], out: Out<'_>) {
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

    fn take_responses(&mut self, t: u64, out: Out<'_>) {
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

    /// The entry of ppoll() for this connection. A negative fd is skipped by ppoll(), and its revents stay 0.
    fn poll(&self) -> libc::pollfd {
        let writing = if self.blocked { libc::POLLOUT } else { 0 };
        let fd = if self.open { self.socket.as_raw_fd() } else { -1 };
        libc::pollfd { fd, events: libc::POLLIN | libc::POLLRDHUP | writing, revents: 0 }
    }

    fn handle(&mut self, events: i16, buf: &mut [u8], out: Out<'_>) {
        if events & libc::POLLOUT != 0 {
            self.blocked = false;
        }
        if events & !libc::POLLOUT != 0 {
            self.receive(buf, out);
        }
    }
}

/// The one arrival that a connection of a pool or of a fresh stream carries.
#[derive(Clone, Copy, Debug)]
struct Flight {
    i: usize,
    /// the bytes of the request already written
    written: usize,
    /// the time that the arrival waited for its connection, in ns: for an idle connection, or for the connect
    wait: u64,
    /// the request is all written
    sent: bool,
}

/// One connection of a pool or of a fresh stream.
struct Link {
    socket: TcpStream,
    /// the number of the connection in its stream, from 0
    c: usize,
    /// the start of a connect that is not done yet
    connecting: Option<u64>,
    flight: Option<Flight>,
    /// the socket took no more bytes: the next write waits for POLLOUT
    blocked: bool,
    open: bool,
    /// the connection stays open after a reply (a pool), or closes (a fresh stream)
    keep: bool,
    /// the time from which the connection has no request in flight
    idle_since: u64,
    /// the bytes received and not yet a whole response
    buffer: Vec<u8>,
}

impl Link {
    fn idle(&self) -> bool {
        self.open && self.connecting.is_none() && self.flight.is_none()
    }

    /// The fields of a line about this connection: the stream, the connection and its arrival, if any.
    fn fields(&self, stream: &Stream) -> Value {
        let mut fields = json!({ "k": stream.key, "c": self.c });
        if let Some(flight) = self.flight {
            fields["i"] = json!(flight.i);
        }
        fields
    }

    fn end(&mut self, stream: &Stream, event: &str, t: u64, extra: Value, out: Out<'_>) {
        let mut fields = self.fields(stream);
        if let (Some(fields), Value::Object(extra)) = (fields.as_object_mut(), extra) {
            fields.extend(extra);
        }
        out(event, t, fields);
        self.open = false;
    }

    fn fail(&mut self, stream: &Stream, out: Out<'_>, error: &std::io::Error) {
        self.end(stream, "error", monotonic_ns(), json!({ "errno": errno_of(error) }), out);
    }

    /// Writes the request of the flight until it is all written or the socket takes no more. It gives
    /// true when the request becomes all written.
    fn write(&mut self, stream: &Stream, out: Out<'_>) -> bool {
        while self.open && !self.blocked && self.connecting.is_none() {
            let Some(flight) = self.flight else { return false };
            if flight.sent {
                return false;
            }
            let request = &stream.requests[flight.i % stream.requests.len()];
            let t = monotonic_ns();
            match self.socket.write(&request[flight.written..]) {
                Ok(n) => {
                    let written = flight.written + n;
                    let sent = written == request.len();
                    self.flight = Some(Flight { written, sent, ..flight });
                    if sent {
                        out("sent", t, json!({ "k": stream.key, "i": flight.i, "wait": flight.wait }));
                        return true;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => self.blocked = true,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => self.fail(stream, out, &error),
            }
        }
        false
    }

    /// Reads what the socket holds, and gives a replied line for the response of the flight.
    fn receive(&mut self, stream: &Stream, buf: &mut [u8], out: Out<'_>) {
        while self.open {
            match self.socket.read(buf) {
                Ok(0) => self.end(stream, "eof", monotonic_ns(), json!({}), out),
                Ok(n) => {
                    let t = monotonic_ns();
                    self.buffer.extend_from_slice(&buf[..n]);
                    self.take_response(stream, t, out);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => self.fail(stream, out, &error),
            }
        }
    }

    fn take_response(&mut self, stream: &Stream, t: u64, out: Out<'_>) {
        while self.open {
            match response_length(&self.buffer) {
                Ok(None) => return,
                Ok(Some((length, status))) => match self.flight {
                    Some(flight) if flight.sent => {
                        self.buffer.drain(..length);
                        out("replied", t, json!({ "k": stream.key, "i": flight.i, "status": status }));
                        self.flight = None;
                        self.idle_since = t;
                        // a fresh stream closes its connection after the reply
                        self.open = self.keep;
                    }
                    _ => self.end(stream, "error", t, json!({ "why": "a response with no whole request before it" }), out),
                },
                Err(why) => self.end(stream, "error", t, json!({ "why": why }), out),
            }
        }
    }

    /// The entry of ppoll() for this connection: a connect waits for POLLOUT only.
    fn poll(&self) -> libc::pollfd {
        let fd = if self.open { self.socket.as_raw_fd() } else { -1 };
        let events = if self.connecting.is_some() {
            libc::POLLOUT
        } else {
            libc::POLLIN | libc::POLLRDHUP | if self.blocked { libc::POLLOUT } else { 0 }
        };
        libc::pollfd { fd, events, revents: 0 }
    }

    fn handle(&mut self, stream: &Stream, events: i16, buf: &mut [u8], out: Out<'_>) {
        if !self.open || events == 0 {
            return;
        }
        if let Some(begun) = self.connecting {
            // the connect is over: SO_ERROR tells if it failed
            match self.socket.take_error() {
                Ok(None) => {
                    let now = monotonic_ns();
                    self.connecting = None;
                    self.idle_since = now;
                    if let Some(flight) = self.flight.as_mut() {
                        flight.wait = now.saturating_sub(begun);
                    }
                }
                Ok(Some(error)) | Err(error) => self.fail(stream, out, &error),
            }
            return;
        }
        if events & libc::POLLOUT != 0 {
            self.blocked = false;
        }
        if events & !libc::POLLOUT != 0 {
            self.receive(stream, buf, out);
        }
    }
}

/// The address `address` as a sockaddr for connect(), with its length.
fn sockaddr_of(address: &SocketAddr) -> (libc::sockaddr_storage, libc::socklen_t) {
    // SAFETY: a sockaddr_storage of zero bytes is a valid value
    let mut storage: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    match address {
        SocketAddr::V4(v4) => {
            // SAFETY: a sockaddr_storage is large enough for a sockaddr_in, and aligned for it
            let sin = unsafe { &mut *(&mut storage as *mut libc::sockaddr_storage).cast::<libc::sockaddr_in>() };
            sin.sin_family = libc::AF_INET as libc::sa_family_t;
            sin.sin_port = v4.port().to_be();
            // the octets are in the order of the network, and s_addr holds them in that order
            sin.sin_addr.s_addr = u32::from_ne_bytes(v4.ip().octets());
            (storage, std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t)
        }
        SocketAddr::V6(v6) => {
            // SAFETY: a sockaddr_storage is large enough for a sockaddr_in6, and aligned for it
            let sin6 = unsafe { &mut *(&mut storage as *mut libc::sockaddr_storage).cast::<libc::sockaddr_in6>() };
            sin6.sin6_family = libc::AF_INET6 as libc::sa_family_t;
            sin6.sin6_port = v6.port().to_be();
            sin6.sin6_flowinfo = v6.flowinfo();
            sin6.sin6_addr.s6_addr = v6.ip().octets();
            sin6.sin6_scope_id = v6.scope_id();
            (storage, std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t)
        }
    }
}

/// Starts a connect to `address` that does not block. It gives the socket, and true when the connect
/// is already done. Else the socket gives POLLOUT when the connect is over, and SO_ERROR tells if it failed.
fn connect_start(address: &SocketAddr) -> std::io::Result<(TcpStream, bool)> {
    let family = if address.is_ipv4() { libc::AF_INET } else { libc::AF_INET6 };
    // SAFETY: socket() takes no pointer
    let fd = unsafe { libc::socket(family, libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the fd is new and open, and the TcpStream owns it from here: it closes it on each path
    let socket = unsafe { TcpStream::from_raw_fd(fd) };
    socket.set_nodelay(true)?;
    let (storage, length) = sockaddr_of(address);
    // SAFETY: the storage lives on this frame, and `length` is the size of the address in it
    let code = unsafe { libc::connect(fd, (&storage as *const libc::sockaddr_storage).cast::<libc::sockaddr>(), length) };
    if code == 0 {
        return Ok((socket, true));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EINPROGRESS) {
        Ok((socket, false))
    } else {
        Err(error)
    }
}

/// One stream in the mode pool or fresh: its connections, and where it is in its schedule.
struct Pool {
    stream: Stream,
    address: SocketAddr,
    links: Vec<Link>,
    /// the due arrivals of a pool that wait for an idle connection, in the order of the schedule
    queue: VecDeque<usize>,
    /// the next arrival that is not yet due
    next: usize,
    /// the arrivals with their request all written
    sent: usize,
    /// the connections opened so far: the number of the next one
    opened: usize,
}

impl Pool {
    /// Opens each connection of a pool, or none for a fresh stream.
    fn open(address: SocketAddr, stream: Stream) -> std::io::Result<Self> {
        let size = if let Mode::Pool(size) = stream.mode { size } else { 0 };
        let mut links = Vec::with_capacity(size);
        for c in 0..size {
            let socket = TcpStream::connect(address)?;
            socket.set_nodelay(true)?;
            socket.set_nonblocking(true)?;
            links.push(Link { socket, c, connecting: None, flight: None, blocked: false, open: true, keep: true, idle_since: monotonic_ns(), buffer: Vec::new() });
        }
        Ok(Self { stream, address, links, queue: VecDeque::new(), next: 0, sent: 0, opened: size })
    }

    /// Tells if the stream can do no more: each arrival is due and over, or each connection of the pool ended.
    fn finished(&self) -> bool {
        let over = self.next == self.stream.times.len() && self.queue.is_empty() && self.links.iter().all(|link| link.flight.is_none());
        over || (matches!(self.stream.mode, Mode::Pool(_)) && self.links.is_empty())
    }

    /// Starts a connect for the arrival `i` of a fresh stream. A failed connect is an error of that arrival only.
    fn connect(&mut self, i: usize, out: Out<'_>) {
        let begun = monotonic_ns();
        match connect_start(&self.address) {
            Ok((socket, done)) => {
                let now = monotonic_ns();
                let flight = Flight { i, written: 0, wait: if done { now.saturating_sub(begun) } else { 0 }, sent: false };
                let connecting = if done { None } else { Some(begun) };
                self.links.push(Link { socket, c: self.opened, connecting, flight: Some(flight), blocked: false, open: true, keep: false, idle_since: now, buffer: Vec::new() });
                self.opened += 1;
            }
            Err(error) => out("error", monotonic_ns(), json!({ "k": self.stream.key, "i": i, "errno": errno_of(&error) })),
        }
    }

    /// Takes each arrival that is due at `start`, gives it a connection, and writes each request that can go.
    fn send_due(&mut self, start: u64, out: Out<'_>) {
        let now = monotonic_ns();
        while self.next < self.stream.times.len() && now >= start + self.stream.times[self.next] {
            let i = self.next;
            self.next += 1;
            match self.stream.mode {
                Mode::Fresh => self.connect(i, out),
                _ => self.queue.push_back(i),
            }
        }
        // each queued arrival takes the connection that is idle for the longest time
        while let Some(&i) = self.queue.front() {
            let idle = self.links.iter().enumerate().filter(|(_, link)| link.idle()).min_by_key(|(_, link)| link.idle_since).map(|(at, _)| at);
            let Some(at) = idle else { break };
            self.queue.pop_front();
            let due = start + self.stream.times[i];
            let link = &mut self.links[at];
            link.flight = Some(Flight { i, written: 0, wait: link.idle_since.saturating_sub(due), sent: false });
        }
        for link in self.links.iter_mut() {
            if link.write(&self.stream, out) {
                self.sent += 1;
            }
        }
        self.links.retain(|link| link.open);
    }

    fn handle(&mut self, polled: &[libc::pollfd], buf: &mut [u8], out: Out<'_>) {
        for (link, entry) in self.links.iter_mut().zip(polled) {
            link.handle(&self.stream, entry.revents, buf, out);
        }
        self.links.retain(|link| link.open);
    }
}

/// One stream of the driver, in its mode.
enum Flow {
    Pipeline(Connection),
    Pool(Pool),
}

impl Flow {
    fn stream(&self) -> &Stream {
        match self {
            Flow::Pipeline(connection) => &connection.stream,
            Flow::Pool(pool) => &pool.stream,
        }
    }

    fn send_due(&mut self, start: u64, out: Out<'_>) {
        match self {
            Flow::Pipeline(connection) => connection.send_due(start, out),
            Flow::Pool(pool) => pool.send_due(start, out),
        }
    }

    fn finished(&self) -> bool {
        match self {
            Flow::Pipeline(connection) => connection.finished(),
            Flow::Pool(pool) => pool.finished(),
        }
    }

    /// The count of arrivals with their request all written.
    fn sent(&self) -> usize {
        match self {
            Flow::Pipeline(connection) => connection.next,
            Flow::Pool(pool) => pool.sent,
        }
    }

    /// The time of the next arrival that the stream can send, in ns from the start.
    fn due(&self) -> Option<u64> {
        match self {
            Flow::Pipeline(connection) if connection.open && !connection.blocked => connection.stream.times.get(connection.next).copied(),
            Flow::Pipeline(_) => None,
            Flow::Pool(pool) => pool.stream.times.get(pool.next).copied(),
        }
    }

    /// Adds the entries of ppoll() for the connections of this stream.
    fn polls(&self, polled: &mut Vec<libc::pollfd>) {
        match self {
            Flow::Pipeline(connection) => polled.push(connection.poll()),
            Flow::Pool(pool) => polled.extend(pool.links.iter().map(Link::poll)),
        }
    }

    /// Reads the revents of the entries that `polls` added, in the same order.
    fn handle(&mut self, polled: &[libc::pollfd], buf: &mut [u8], out: Out<'_>) {
        match self {
            Flow::Pipeline(connection) => {
                if let Some(entry) = polled.first() {
                    connection.handle(entry.revents, buf, out);
                }
            }
            Flow::Pool(pool) => pool.handle(polled, buf, out),
        }
    }
}

/// Waits up to `ns` for the connections of `polled`, and sets their revents. A wait in ms is too
/// coarse for a schedule, thus this one is ppoll(). With no entry, it is a sleep.
fn wait_for(polled: &mut [libc::pollfd], ns: u64) -> std::io::Result<()> {
    let time = libc::timespec { tv_sec: (ns / 1_000_000_000) as libc::time_t, tv_nsec: (ns % 1_000_000_000) as libc::c_long };
    // SAFETY: the pollfds and the timespec live past the call, with their exact count, and no signal mask
    if unsafe { libc::ppoll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, &time, std::ptr::null()) } == -1 {
        let error = std::io::Error::last_os_error();
        if error.kind() != ErrorKind::Interrupted {
            return Err(error);
        }
        for entry in polled.iter_mut() {
            entry.revents = 0;
        }
    }
    Ok(())
}

/// Runs the schedule of each stream from `start`, until each stream is finished or the deadline
/// passes. A wait is at most `tick` ns.
fn drive(flows: &mut [Flow], start: u64, deadline: u64, tick: u64, out: Out<'_>) -> Result<(), Box<dyn Error>> {
    let mut buf = vec![0u8; 65_536];
    let mut polled: Vec<libc::pollfd> = Vec::new();
    let mut counts: Vec<usize> = Vec::with_capacity(flows.len());
    loop {
        for flow in flows.iter_mut() {
            flow.send_due(start, out);
        }
        if flows.iter().all(Flow::finished) {
            let requests: usize = flows.iter().map(Flow::sent).sum();
            out("done", monotonic_ns(), json!({ "requests": requests }));
            return Ok(());
        }
        let now = monotonic_ns();
        if now > deadline {
            out("deadline", now, json!({}));
            return Ok(());
        }
        let due = flows.iter().filter_map(Flow::due).map(|at| (start + at).saturating_sub(now)).fold(tick, u64::min);
        polled.clear();
        counts.clear();
        for flow in flows.iter() {
            let before = polled.len();
            flow.polls(&mut polled);
            counts.push(polled.len() - before);
        }
        wait_for(&mut polled, due)?;
        let mut at = 0;
        for (flow, count) in flows.iter_mut().zip(counts.iter().copied()) {
            flow.handle(&polled[at..at + count], &mut buf, out);
            at += count;
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
    let address = (args.host.as_str(), args.port).to_socket_addrs()?.next().ok_or("the target's host has no address")?;
    let mut flows = Vec::with_capacity(streams.len());
    for stream in streams {
        let key = stream.key.clone();
        // the harness finds the socket of a stream in the records of the kernel by its local address
        if stream.mode == Mode::Pipeline {
            let connection = Connection::open(address, stream)?;
            emit("connected", json!({ "k": key, "local": connection.socket.local_addr()?.to_string() }));
            flows.push(Flow::Pipeline(connection));
        } else {
            let pool = Pool::open(address, stream)?;
            for link in &pool.links {
                emit("connected", json!({ "k": key, "c": link.c, "local": link.socket.local_addr()?.to_string() }));
            }
            flows.push(Flow::Pool(pool));
        }
    }
    emit("ready", json!({ "streams": flows.len() }));
    while !Path::new(&args.go).exists() {
        if monotonic_ns() > deadline {
            emit("deadline", json!({}));
            return Ok(());
        }
        std::thread::sleep(args.sample);
    }
    let start = monotonic_ns();
    let arrivals: usize = flows.iter().map(|flow| flow.stream().times.len()).sum();
    emit_at("scheduled", start, json!({ "streams": flows.len(), "arrivals": arrivals }));
    drive(&mut flows, start, deadline, args.sample.as_nanos() as u64, &mut |event, t, fields| emit_at(event, t, fields))
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
        assert_eq!(streams[0].mode, Mode::Pipeline);
        assert!(plan_of(r#"{"format":"other","streams":[]}"#).is_err());
        assert!(plan_of(r#"{"format":"systems-load/1","streams":[]}"#).is_err());
        let twice = format!(r#"{{"format":"systems-load/1","streams":[{{"key":"a","schedule":{schedule},"requests":["A"]}},{{"key":"a","schedule":{schedule},"requests":["A"]}}]}}"#);
        assert!(plan_of(&twice).is_err());
        let none = format!(r#"{{"format":"systems-load/1","streams":[{{"key":"a","schedule":{schedule},"requests":[]}}]}}"#);
        assert!(plan_of(&none).is_err());
    }

    #[test]
    fn a_plan_gives_the_mode_of_each_stream_and_refuses_a_bad_one() {
        let schedule = r#"{"format":"rigor-schedule/1","times":[0]}"#;
        let with = |connections: &str| plan_of(&format!(r#"{{"format":"systems-load/1","streams":[{{"key":"a","schedule":{schedule},"requests":["A"],"connections":{connections}}}]}}"#));
        assert_eq!(with(r#"{"mode":"pipeline"}"#).unwrap()[0].mode, Mode::Pipeline);
        assert_eq!(with(r#"{"mode":"pool","size":8}"#).unwrap()[0].mode, Mode::Pool(8));
        assert_eq!(with(r#"{"mode":"pool","size":1024}"#).unwrap()[0].mode, Mode::Pool(1024));
        assert_eq!(with(r#"{"mode":"fresh"}"#).unwrap()[0].mode, Mode::Fresh);
        assert_eq!(with("null").unwrap()[0].mode, Mode::Pipeline);
        for bad in [r#"{"mode":"pool"}"#, r#"{"mode":"pool","size":0}"#, r#"{"mode":"pool","size":1025}"#, r#"{"mode":"pool","size":1.5}"#, r#"{"mode":"pool","size":-1}"#, r#"{"mode":"other"}"#, r#"{}"#, r#""pool""#] {
            assert!(with(bad).is_err(), "{bad}");
        }
    }

    /// A server that answers each request of each connection with OK, after `delay` for a request with
    /// the word `slow`. It takes `connections` connections, and answers the requests of one connection in order.
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

    fn local(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    fn request(path: &str) -> Vec<u8> {
        format!("GET /{path} HTTP/1.1\r\nHost: t\r\n\r\n").into_bytes()
    }

    fn stream(key: &str, times: &[u64]) -> Stream {
        Stream { key: key.into(), times: times.to_vec(), requests: vec![request(key)], mode: Mode::Pipeline }
    }

    const MS: u64 = 1_000_000;

    /// Runs the flows for at most 10 s, and gives their lines and the start.
    fn lines_of(flows: &mut [Flow]) -> (Vec<(String, u64, Value)>, u64) {
        let mut events: Vec<(String, u64, Value)> = Vec::new();
        let start = monotonic_ns();
        drive(flows, start, start + 10_000 * MS, MS, &mut |event, t, fields| events.push((event.into(), t, fields))).unwrap();
        (events, start)
    }

    /// The lines `event` of the stream `key`, in their order.
    fn of<'a>(events: &'a [(String, u64, Value)], event: &'a str, key: &'a str) -> impl Iterator<Item = &'a (String, u64, Value)> + 'a {
        events.iter().filter(move |(ev, _, fields)| ev == event && fields["k"] == key)
    }

    #[test]
    fn each_stream_gets_each_reply_and_a_slow_stream_delays_only_itself() {
        let port = serve(2, Duration::from_millis(200));
        let mut flows = vec![
            Flow::Pipeline(Connection::open(local(port), stream("slow", &[0, MS, 2 * MS])).unwrap()),
            Flow::Pipeline(Connection::open(local(port), stream("fast", &[0, MS, 2 * MS])).unwrap()),
        ];
        let (events, start) = lines_of(&mut flows);
        let replied = |key: &str| -> Vec<u64> { of(&events, "replied", key).map(|(_, t, _)| t - start).collect() };
        assert_eq!(replied("slow").len(), 3);
        assert_eq!(replied("fast").len(), 3);
        assert!(events.iter().filter(|(event, _, _)| event == "replied").all(|(_, _, fields)| fields["status"] == 200));
        // the last reply of the fast stream comes before the first of the slow one
        assert!(replied("fast")[2] < replied("slow")[0], "{events:?}");
        let sent = events.iter().filter(|(event, _, _)| event == "sent").count();
        assert_eq!(sent, 6);
        // a pipeline gives no wait: its lines stay as they were
        assert!(events.iter().filter(|(event, _, _)| event == "sent").all(|(_, _, fields)| fields.get("wait").is_none()));
        assert_eq!(events.last().map(|(event, _, fields)| (event.as_str(), fields["requests"].clone())), Some(("done", json!(6))));
    }

    #[test]
    fn a_pool_sends_one_request_on_each_connection_and_a_fast_reply_passes_a_slow_one() {
        let port = serve(2, Duration::from_millis(200));
        // the arrivals 0 and 2 are slow, and the arrivals 1 and 3 are fast
        let pooled = Stream { requests: vec![request("slow"), request("fast")], mode: Mode::Pool(2), ..stream("p", &[0, MS, 2 * MS, 3 * MS]) };
        let mut flows = vec![Flow::Pool(Pool::open(local(port), pooled).unwrap())];
        let (events, start) = lines_of(&mut flows);
        let replied: Vec<u64> = of(&events, "replied", "p").map(|(_, _, fields)| fields["i"].as_u64().unwrap()).collect();
        let mut each = replied.clone();
        each.sort_unstable();
        assert_eq!(each, [0, 1, 2, 3], "{events:?}");
        // the fast arrival 1 replies before the slow arrival 0, on its own connection
        let at = |i: u64| replied.iter().position(|&each| each == i).unwrap();
        assert!(at(1) < at(0), "{events:?}");
        // the arrival 3 waits for a connection: a slow reply ends first. That wait is not a lag of the driver
        let sent = |i: u64| of(&events, "sent", "p").find(|(_, _, fields)| fields["i"] == i).cloned().unwrap();
        let (_, t, fields) = sent(3);
        let wait = fields["wait"].as_u64().unwrap();
        assert!(wait >= 100 * MS, "{events:?}");
        let lag = (t - start) as i64 - wait as i64 - (3 * MS) as i64;
        assert!(lag.abs() < (50 * MS) as i64, "the lag {lag} ns, {events:?}");
        assert_eq!(sent(0).2["wait"], 0);
        assert_eq!(events.last().map(|(event, _, fields)| (event.as_str(), fields["requests"].clone())), Some(("done", json!(4))));
    }

    #[test]
    fn a_fresh_stream_opens_a_connection_for_each_arrival_and_its_requests_overlap() {
        let port = serve(3, Duration::from_millis(200));
        let fresh = Stream { mode: Mode::Fresh, ..stream("slow", &[0, MS, 2 * MS]) };
        let mut flows = vec![Flow::Pool(Pool::open(local(port), fresh).unwrap())];
        let (events, start) = lines_of(&mut flows);
        let replied: Vec<u64> = of(&events, "replied", "slow").map(|(_, t, _)| t - start).collect();
        assert_eq!(replied.len(), 3, "{events:?}");
        // one connection would answer the three in turn, after 600 ms
        assert!(replied.iter().all(|&t| t < 500 * MS), "{events:?}");
        assert!(of(&events, "sent", "slow").all(|(_, _, fields)| fields["wait"].as_u64().is_some()));
        assert!(!events.iter().any(|(event, _, _)| event == "error" || event == "eof"), "{events:?}");
        assert_eq!(events.last().map(|(event, _, fields)| (event.as_str(), fields["requests"].clone())), Some(("done", json!(3))));
    }

    #[test]
    fn a_failed_connect_of_a_fresh_stream_is_an_error_of_its_arrival_only() {
        // a port with no listener refuses each connect
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let fresh = Stream { mode: Mode::Fresh, ..stream("gone", &[0, 5 * MS]) };
        let mut flows = vec![Flow::Pool(Pool::open(local(port), fresh).unwrap())];
        let (events, _) = lines_of(&mut flows);
        let failed: Vec<Value> = of(&events, "error", "gone").map(|(_, _, fields)| fields["i"].clone()).collect();
        assert_eq!(failed, [json!(0), json!(1)], "{events:?}");
        assert!(of(&events, "error", "gone").all(|(_, _, fields)| fields["errno"] == "ECONNREFUSED"), "{events:?}");
        assert_eq!(events.last().map(|(event, _, fields)| (event.as_str(), fields["requests"].clone())), Some(("done", json!(0))));
    }
}
