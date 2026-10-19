//! inject ACTION ARGS... [--at NS]
//!
//! A cell's fault, applied inside the network namespace this sidecar shares with the target (or,
//! for the server's side, with the client), so the target's image stays stock. Each lands in one
//! commit, bracketed by CLOCK_MONOTONIC stamps taken in the VM: a docker exec from Windows lands
//! 190 ms late at the median, and the bracket does not care.
//!
//! The actions, each with its lift:
//!
//! - `blackhole PEER [--direction both|in|out]` / `clear PEER [--direction …]`: the peer's
//!   segments drop, in both directions or one. `in` drops what comes from the peer, `out` what
//!   goes to it: a simplex partition.
//! - `rst PEER` / `clear-rst PEER`: the peer's next segment is answered with a reset, so its next
//!   send fails at once. A REJECT resets only the sender of the matched segment: the target's
//!   process never hears of it.
//! - `reject PEER --code host|net|port|admin` / `clear-reject PEER --code …`: each segment from the
//!   peer is answered with that ICMP unreachable. On an established socket Linux keeps it as a
//!   soft error (tcp_v4_err) and goes on retransmitting.
//! - `mtu PEER --above N` / `clear-mtu PEER --above N`: each segment from the peer longer than N
//!   bytes drops, as a path MTU black hole does, in the namespace that receives it. It acts on
//!   segments only when the sender's TSO and GSO and the receiver's GRO are off (`offload`).
//! - `netem DEV SPEC…` / `clear-netem DEV`: tc netem on the device's egress, for example
//!   `netem eth0 delay 100ms 10ms` or `netem eth0 loss 5%`.
//! - `offload DEV on|off`: the device's TSO, GSO and GRO, so that netem and length matches act on
//!   segments rather than on GSO super-packets of up to 64 KB.
//! - `http METHOD ADDR:PORT PATH [BODY]`: one HTTP/1.1 request to an API in the VM, for example a
//!   toxic of Toxiproxy. The stamps bracket the request and its answer, after the connect, so the
//!   commit of the toxic is known on the same clock as the kernel's records.
//!
//! - `signal NAME SIGNAL`: SIGNAL (KILL, STOP, CONT, TERM or HUP) to each process whose name is
//!   NAME, in the process namespace this sidecar shares with a member of a group or a hop. STOP and
//!   CONT freeze a server and thaw it while its kernel stays up; KILL stops it, and its kernel
//!   closes its sockets; HUP asks a pooler to read its configuration again. The stamps bracket the
//!   kill(2) calls.
//! - `resp ADDR:PORT ARG...`: one command to a Redis-protocol server, for example
//!   `SENTINEL FAILOVER mymaster` to a Sentinel. The stamps bracket the write of the command and
//!   the first line of its reply, so a planned failover starts at a known instant.
//! - `query ADDR:PORT USER DATABASE SQL`: one simple query to a server of the PostgreSQL protocol
//!   that trusts the user, for example `PAUSE` on the console of PgBouncer. The stamps bracket the
//!   write of the query and its ReadyForQuery, after the login, so the end of a PAUSE is known.
//!
//! A filter rule's PEER can be a list, `A,B,C`: the rules for each peer go in the same commit, so
//! a part of a group loses all of its peers at one instant.
//!
//! `--at NS` holds the commit until that instant on CLOCK_MONOTONIC, the clock every stamp is on.
//! A stall's end is timed that way, from inside the VM: the exec only has to arrive before it, and
//! its 190 ms never reach the stall's length.
//!
//! `--via DEV` puts a filter rule in the FORWARD chain, for a router: its INPUT and OUTPUT see only
//! what the router itself sends and receives. The rule faces one side by the device toward it:
//! what comes from the peer arrives on DEV (`-i DEV -s PEER`), and what goes to it leaves on DEV
//! (`-o DEV -d PEER`). A REJECT then answers from the router: a reset spoofs the address the
//! segment was going to, and an ICMP error comes from the router's own address on DEV.

use prober::monotonic_ns;
use serde_json::json;
use std::error::Error;
use std::io::Write;
use std::net::Ipv4Addr;
use std::process::{Command, Stdio};

/// sleeps until an instant on CLOCK_MONOTONIC, or returns at once if it has passed
fn until(at: u64) -> Result<(), Box<dyn Error>> {
    let deadline = libc::timespec {
        // the fields' own types: musl is moving time_t to 64 bits
        tv_sec: (at / 1_000_000_000) as _,
        tv_nsec: (at % 1_000_000_000) as _,
    };
    loop {
        // SAFETY: a valid timespec, and no remainder is asked for with an absolute time
        let code = unsafe {
            libc::clock_nanosleep(
                libc::CLOCK_MONOTONIC,
                libc::TIMER_ABSTIME,
                &deadline,
                std::ptr::null_mut(),
            )
        };
        match code {
            0 => return Ok(()),
            libc::EINTR => continue,
            other => return Err(format!("clock_nanosleep failed: {other}").into()),
        }
    }
}

/// The options after the positional arguments: `--at NS`, `--direction D`, `--code C`, `--above N`,
/// `--via DEV`.
#[derive(Default)]
struct Options {
    at: Option<u64>,
    direction: Option<String>,
    code: Option<String>,
    above: Option<u32>,
    via: Option<String>,
}

fn options(args: &[String]) -> Result<Options, Box<dyn Error>> {
    let mut out = Options::default();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or_else(|| format!("{flag} takes a value"))?;
        match flag.as_str() {
            "--at" => out.at = Some(value.parse()?),
            "--direction" => out.direction = Some(value.clone()),
            "--code" => out.code = Some(value.clone()),
            "--above" => out.above = Some(value.parse()?),
            "--via" => out.via = Some(device(value)?.to_string()),
            other => return Err(format!("unknown option {other}").into()),
        }
    }
    Ok(out)
}

/// The iptables rules of an action that is a filter rule, or None for an action that is not.
fn rules(action: &str, peer: Ipv4Addr, opts: &Options) -> Result<String, Box<dyn Error>> {
    let op = |set: &str| if action == set { "-I" } else { "-D" };
    // what comes from the peer, and what goes to it: at an end, the INPUT and OUTPUT of its own
    // sockets; at a router, what it forwards in and out of the device toward the peer
    let (from, to) = match opts.via.as_deref() {
        None => (format!("INPUT -s {peer}/32"), format!("OUTPUT -d {peer}/32")),
        Some(dev) => (format!("FORWARD -i {dev} -s {peer}/32"), format!("FORWARD -o {dev} -d {peer}/32")),
    };
    Ok(match action {
        "blackhole" | "clear" => {
            let op = op("blackhole");
            let direction = opts.direction.as_deref().unwrap_or("both");
            let input = format!("{op} {from} -j DROP\n");
            let output = format!("{op} {to} -j DROP\n");
            match direction {
                "both" => format!("{input}{output}"),
                "in" => input,
                "out" => output,
                other => return Err(format!("unknown direction {other}").into()),
            }
        }
        "rst" | "clear-rst" => {
            let op = op("rst");
            format!("{op} {from} -p tcp -j REJECT --reject-with tcp-reset\n")
        }
        "reject" | "clear-reject" => {
            let op = op("reject");
            let with = match opts.code.as_deref().ok_or("--code host|net|port|admin")? {
                "host" => "icmp-host-unreachable",
                "net" => "icmp-net-unreachable",
                "port" => "icmp-port-unreachable",
                "admin" => "icmp-admin-prohibited",
                other => return Err(format!("unknown code {other}").into()),
            };
            format!("{op} {from} -p tcp -j REJECT --reject-with {with}\n")
        }
        // the long segments drop where they arrive: in the sender's own namespace, an OUTPUT drop
        // would fail its sends with EPERM rather than lose them on the way
        "mtu" | "clear-mtu" => {
            let op = op("mtu");
            let above = opts.above.ok_or("--above N")?;
            format!("{op} {from} -p tcp -m length --length {}:65535 -j DROP\n", above + 1)
        }
        other => return Err(format!("unknown action {other}").into()),
    })
}

/// a token of a netem specification: a word, or a number with an optional unit
fn netem_token(token: &str) -> bool {
    let word = !token.is_empty() && token.chars().all(|c| c.is_ascii_lowercase());
    let number = token
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%')
        .parse::<f64>()
        .is_ok()
        && token
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.')
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '%');
    word || number
}

/// a device name: letters, digits, dots, dashes
fn device(name: &str) -> Result<&str, Box<dyn Error>> {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        Ok(name)
    } else {
        Err(format!("not a device: {name}").into())
    }
}

/// runs a command and fails with its stderr when it fails
fn command(program: &str, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let out = Command::new(program).args(args).output()?;
    if !out.status.success() {
        return Err(format!(
            "{program} {} exited {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into());
    }
    Ok(())
}

/// an HTTP path: a slash, then letters, digits and `/ - _ .` only
fn http_path(path: &str) -> Result<&str, Box<dyn Error>> {
    if path.starts_with('/')
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        Ok(path)
    } else {
        Err(format!("not an HTTP path: {path}").into())
    }
}

/// the head of one HTTP/1.1 request, with its body
fn http_request(method: &str, host: &str, path: &str, body: &str) -> Result<String, Box<dyn Error>> {
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err(format!("not a method: {method}").into());
    }
    Ok(format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ))
}

/// one request to an API: the status, and the stamps around the request and its answer
fn http(args: &[String]) -> Result<(), Box<dyn Error>> {
    use std::io::Read;
    use std::net::{SocketAddrV4, TcpStream};
    let method = args.get(1).ok_or("http METHOD ADDR:PORT PATH [BODY]")?.as_str();
    let addr: SocketAddrV4 = args.get(2).ok_or("and the address and port")?.parse()?;
    let path = http_path(args.get(3).ok_or("and the path")?)?;
    let body = args.get(4).map_or("", String::as_str);
    let request = http_request(method, &addr.to_string(), path, body)?;
    let mut stream = TcpStream::connect(addr)?;
    let t0 = monotonic_ns();
    stream.write_all(request.as_bytes())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer)?;
    let t1 = monotonic_ns();
    let text = String::from_utf8_lossy(&answer);
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .ok_or("no status in the answer")?
        .parse()?;
    if !(200..300).contains(&status) {
        let detail = text.split("\r\n\r\n").nth(1).unwrap_or("").trim();
        return Err(format!("{method} {path} answered {status}: {detail}").into());
    }
    println!("{}", json!({ "action": "http", "method": method, "path": path, "status": status, "t0": t0, "t1": t1 }));
    Ok(())
}

/// the number of a signal that `signal` sends, by its name
fn signal_number(name: &str) -> Result<libc::c_int, Box<dyn Error>> {
    Ok(match name {
        "KILL" => libc::SIGKILL,
        "STOP" => libc::SIGSTOP,
        "CONT" => libc::SIGCONT,
        "TERM" => libc::SIGTERM,
        "HUP" => libc::SIGHUP,
        other => return Err(format!("not a signal this injector sends: {other}").into()),
    })
}

/// a process name: letters, digits, dots, dashes and underscores, as /proc/PID/comm holds it
fn process_name(name: &str) -> Result<&str, Box<dyn Error>> {
    if !name.is_empty()
        && name.len() <= 15
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        Ok(name)
    } else {
        Err(format!("not a process name: {name}").into())
    }
}

/// tells if a line of /proc/PID/stat is a zombie's: its state, after the name in parentheses, is Z
fn zombie(stat: &str) -> bool {
    stat.rfind(')').and_then(|end| stat[end + 1..].split_whitespace().next()) == Some("Z")
}

/// the processes of this process namespace whose name is `name`
fn processes(name: &str) -> Result<Vec<libc::pid_t>, Box<dyn Error>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry.file_name().to_str().and_then(|text| text.parse::<libc::pid_t>().ok()) else {
            continue;
        };
        // a process can end between the listing and the read. A zombie keeps its name until its
        // parent reaps it: a server that a fin killed is one, and no signal reaches it
        let Ok(comm) = std::fs::read_to_string(entry.path().join("comm")) else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        if comm.trim_end() == name && !zombie(&stat) {
            found.push(pid);
        }
    }
    found.sort_unstable();
    Ok(found)
}

/// `signal NAME SIGNAL [--at NS]`: the signal to each process of that name, bracketed by stamps
fn signal(args: &[String]) -> Result<(), Box<dyn Error>> {
    let name = process_name(args.get(1).ok_or("signal NAME SIGNAL [--at NS]")?)?;
    let sig = signal_number(args.get(2).ok_or("and the signal: KILL, STOP, CONT, TERM or HUP")?)?;
    let opts = options(&args[3..])?;
    let pids = processes(name)?;
    if pids.is_empty() {
        return Err(format!("no process {name} in this process namespace").into());
    }
    if let Some(at) = opts.at {
        until(at)?;
    }
    let t0 = monotonic_ns();
    for pid in &pids {
        // SAFETY: kill(2) with a pid that this namespace listed, and a signal from the table above
        if unsafe { libc::kill(*pid, sig) } != 0 {
            return Err(format!("kill {pid} failed: {}", std::io::Error::last_os_error()).into());
        }
    }
    let t1 = monotonic_ns();
    println!("{}", json!({ "action": "signal", "name": name, "signal": args[2], "pids": pids, "t0": t0, "t1": t1 }));
    Ok(())
}

/// a command in the Redis protocol: an array of bulk strings
fn resp_command(args: &[String]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(arg.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// `resp ADDR:PORT ARG...`: one command, and the first line of its reply, bracketed by stamps
fn resp(args: &[String]) -> Result<(), Box<dyn Error>> {
    use std::io::Read;
    use std::net::{SocketAddrV4, TcpStream};
    let addr: SocketAddrV4 = args.get(1).ok_or("resp ADDR:PORT ARG...")?.parse()?;
    let command = &args[2..];
    if command.is_empty() {
        return Err("and the command".into());
    }
    let mut stream = TcpStream::connect(addr)?;
    let t0 = monotonic_ns();
    stream.write_all(&resp_command(command))?;
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Err("the server closed before its reply".into());
        }
        line.push(byte[0]);
    }
    let t1 = monotonic_ns();
    let reply = String::from_utf8_lossy(&line[..line.len() - 2]).to_string();
    if reply.starts_with('-') {
        return Err(format!("{} answered {reply}", command.join(" ")).into());
    }
    println!("{}", json!({ "action": "resp", "command": command, "reply": reply, "t0": t0, "t1": t1 }));
    Ok(())
}

/// a message of the PostgreSQL protocol from the client: its type, its length and its body
fn pg_message(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// the startup message of the protocol 3.0 for a user and a database: it has no type byte
fn pg_startup(user: &str, database: &str) -> Vec<u8> {
    let mut body = 196_608u32.to_be_bytes().to_vec();
    for (key, value) in [("user", user), ("database", database)] {
        body.extend_from_slice(key.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let mut out = ((body.len() + 4) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out
}

/// one message of the server: its type and its body
fn pg_read(stream: &mut impl std::io::Read) -> Result<(u8, Vec<u8>), Box<dyn Error>> {
    let mut head = [0u8; 5];
    stream.read_exact(&mut head)?;
    let length = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if length < 4 {
        return Err("a message of the server is shorter than its length field".into());
    }
    let mut body = vec![0u8; length - 4];
    stream.read_exact(&mut body)?;
    Ok((head[0], body))
}

/// the text of an ErrorResponse: its field M, or the whole body when it has none
fn pg_error(body: &[u8]) -> String {
    body.split(|byte| *byte == 0)
        .filter_map(|field| field.split_first())
        .find(|(kind, _)| **kind == b'M')
        .map(|(_, text)| String::from_utf8_lossy(text).to_string())
        .unwrap_or_else(|| String::from_utf8_lossy(body).to_string())
}

/// `query ADDR:PORT USER DATABASE SQL [--at NS]`: one simple query, and its ReadyForQuery, bracketed
/// by stamps. The login must need no password: the console of PgBouncer with auth_type trust is one
fn query(args: &[String]) -> Result<(), Box<dyn Error>> {
    use std::net::{SocketAddrV4, TcpStream};
    let usage = "query ADDR:PORT USER DATABASE SQL [--at NS]";
    let addr: SocketAddrV4 = args.get(1).ok_or(usage)?.parse()?;
    let user = args.get(2).ok_or(usage)?;
    let database = args.get(3).ok_or(usage)?;
    let sql = args.get(4).ok_or(usage)?;
    let opts = options(&args[5..])?;
    let mut stream = TcpStream::connect(addr)?;
    stream.write_all(&pg_startup(user, database))?;
    // the login: AuthenticationOk, the parameters of the server, then ReadyForQuery
    loop {
        let (kind, body) = pg_read(&mut stream)?;
        match kind {
            b'R' if body.get(..4) == Some(&[0u8, 0, 0, 0][..]) => {}
            b'R' => return Err("the server asks for a password: the query needs a user that it trusts".into()),
            b'E' => return Err(format!("the login failed: {}", pg_error(&body)).into()),
            b'Z' => break,
            _ => {}
        }
    }
    if let Some(at) = opts.at {
        until(at)?;
    }
    let t0 = monotonic_ns();
    let mut text = sql.as_bytes().to_vec();
    text.push(0);
    stream.write_all(&pg_message(b'Q', &text))?;
    let mut tag = String::new();
    loop {
        let (kind, body) = pg_read(&mut stream)?;
        match kind {
            b'C' => tag = String::from_utf8_lossy(body.split(|byte| *byte == 0).next().unwrap_or(&[])).to_string(),
            b'E' => return Err(format!("{sql} failed: {}", pg_error(&body)).into()),
            b'Z' => break,
            _ => {}
        }
    }
    let t1 = monotonic_ns();
    // Terminate: the server closes the session, and the sidecar does not wait for it
    stream.write_all(&pg_message(b'X', &[]))?;
    println!("{}", json!({ "action": "query", "query": sql, "tag": tag, "t0": t0, "t1": t1 }));
    Ok(())
}

/// the peers of a filter rule: one address, or a list `A,B,C`
fn peers(text: &str) -> Result<Vec<Ipv4Addr>, Box<dyn Error>> {
    let list: Vec<Ipv4Addr> = text.split(',').map(str::parse).collect::<Result<_, _>>()?;
    if list.is_empty() {
        return Err("no peer".into());
    }
    Ok(list)
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.first().ok_or("say an action: blackhole, clear, rst, reject, mtu, netem, offload, http …")?.as_str();
    if action == "http" {
        return http(&args);
    }
    if action == "signal" {
        return signal(&args);
    }
    if action == "resp" {
        return resp(&args);
    }
    if action == "query" {
        return query(&args);
    }
    match action {
        "netem" | "clear-netem" | "offload" => {
            let dev = device(args.get(1).ok_or("and a device")?)?;
            let rest: Vec<&str> = args[2..].iter().map(String::as_str).collect();
            let (spec, at) = match rest.iter().position(|token| *token == "--at") {
                Some(index) => (
                    rest[..index].to_vec(),
                    Some(rest.get(index + 1).ok_or("--at takes an instant in ns")?.parse::<u64>()?),
                ),
                None => (rest, None),
            };
            if let Some(at) = at {
                until(at)?;
            }
            let t0 = monotonic_ns();
            match action {
                "netem" => {
                    if spec.is_empty() || !spec.iter().all(|token| netem_token(token)) {
                        return Err(format!("not a netem specification: {}", spec.join(" ")).into());
                    }
                    let mut tc = vec!["qdisc", "replace", "dev", dev, "root", "netem"];
                    tc.extend(spec.iter().copied());
                    command("tc", &tc)?;
                }
                "clear-netem" => command("tc", &["qdisc", "del", "dev", dev, "root"])?,
                _ => {
                    let state = match spec.as_slice() {
                        ["on"] => "on",
                        ["off"] => "off",
                        _ => return Err("offload takes on or off".into()),
                    };
                    command("ethtool", &["-K", dev, "tso", state, "gso", state, "gro", state])?;
                }
            }
            let t1 = monotonic_ns();
            println!("{}", json!({ "action": action, "device": dev, "spec": spec, "t0": t0, "t1": t1 }));
            Ok(())
        }
        _ => {
            // parsed, never pasted: only addresses reach the rules
            let list = peers(args.get(1).ok_or("and the peer's address")?)?;
            let opts = options(&args[2..])?;
            let mut body = String::new();
            for peer in &list {
                body.push_str(&rules(action, *peer, &opts)?);
            }
            let script = format!("*filter\n{body}COMMIT\n");
            if let Some(at) = opts.at {
                until(at)?;
            }
            let t0 = monotonic_ns();
            let mut child =
                Command::new("iptables-restore").arg("--noflush").stdin(Stdio::piped()).spawn()?;
            child.stdin.take().ok_or("iptables-restore took no stdin")?.write_all(script.as_bytes())?;
            let status = child.wait()?;
            let t1 = monotonic_ns();
            if !status.success() {
                return Err(format!("iptables-restore exited {status}").into());
            }
            let named: Vec<String> = list.iter().map(ToString::to_string).collect();
            println!("{}", json!({ "action": action, "peer": named.join(","), "t0": t0, "t1": t1 }));
            Ok(())
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("inject: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netem_specifications_are_words_and_numbers_with_units() {
        for token in ["delay", "100ms", "10ms", "loss", "5%", "25.5%", "distribution", "normal", "1"] {
            assert!(netem_token(token), "{token}");
        }
        for token in ["", ";", "100ms;rm", "$(x)", "-1", "a b"] {
            assert!(!netem_token(token), "{token}");
        }
    }

    #[test]
    fn rules_cover_each_direction_code_and_length() {
        let peer: Ipv4Addr = "10.0.0.2".parse().unwrap();
        let with = |direction: &str| Options { direction: Some(direction.into()), ..Options::default() };
        assert_eq!(rules("blackhole", peer, &with("in")).unwrap(), "-I INPUT -s 10.0.0.2/32 -j DROP\n");
        assert_eq!(rules("clear", peer, &with("out")).unwrap(), "-D OUTPUT -d 10.0.0.2/32 -j DROP\n");
        let code = Options { code: Some("net".into()), ..Options::default() };
        assert!(rules("reject", peer, &code).unwrap().contains("icmp-net-unreachable"));
        let above = Options { above: Some(1200), ..Options::default() };
        assert_eq!(
            rules("mtu", peer, &above).unwrap(),
            "-I INPUT -s 10.0.0.2/32 -p tcp -m length --length 1201:65535 -j DROP\n"
        );
        assert!(rules("reject", peer, &Options::default()).is_err());
    }

    #[test]
    fn a_router_gets_forward_rules_that_face_one_device() {
        let peer: Ipv4Addr = "10.0.0.2".parse().unwrap();
        let via = |direction: Option<&str>| Options {
            direction: direction.map(Into::into),
            via: Some("eth0".into()),
            ..Options::default()
        };
        assert_eq!(
            rules("blackhole", peer, &via(None)).unwrap(),
            "-I FORWARD -i eth0 -s 10.0.0.2/32 -j DROP\n-I FORWARD -o eth0 -d 10.0.0.2/32 -j DROP\n"
        );
        assert_eq!(rules("clear", peer, &via(Some("out"))).unwrap(), "-D FORWARD -o eth0 -d 10.0.0.2/32 -j DROP\n");
        assert_eq!(
            rules("rst", peer, &via(None)).unwrap(),
            "-I FORWARD -i eth0 -s 10.0.0.2/32 -p tcp -j REJECT --reject-with tcp-reset\n"
        );
        let host = Options { code: Some("host".into()), ..via(None) };
        assert_eq!(
            rules("clear-reject", peer, &host).unwrap(),
            "-D FORWARD -i eth0 -s 10.0.0.2/32 -p tcp -j REJECT --reject-with icmp-host-unreachable\n"
        );
        // a device name is letters, digits, dots and dashes: nothing else reaches the rules
        assert!(options(&["--via".into(), "eth0;x".into()]).is_err());
        assert_eq!(options(&["--via".into(), "eth1".into()]).unwrap().via.as_deref(), Some("eth1"));
    }

    #[test]
    fn a_list_of_peers_is_addresses_only() {
        assert_eq!(peers("10.0.0.2").unwrap().len(), 1);
        assert_eq!(peers("10.0.0.2,10.0.0.3,10.0.0.4").unwrap()[2].to_string(), "10.0.0.4");
        for text in ["", "10.0.0.2,", "10.0.0.2;x", "a,b", "10.0.0.2 10.0.0.3"] {
            assert!(peers(text).is_err(), "{text}");
        }
    }

    #[test]
    fn signals_and_process_names_come_from_a_short_list() {
        assert_eq!(signal_number("STOP").unwrap(), libc::SIGSTOP);
        assert_eq!(signal_number("CONT").unwrap(), libc::SIGCONT);
        assert_eq!(signal_number("KILL").unwrap(), libc::SIGKILL);
        assert_eq!(signal_number("HUP").unwrap(), libc::SIGHUP);
        assert!(signal_number("USR1").is_err());
        assert!(process_name("valkey-server").is_ok());
        assert!(process_name("valkey-sentinel").is_ok());
        for name in ["", "a b", "x;y", "much-too-long-a-name"] {
            assert!(process_name(name).is_err(), "{name}");
        }
        // the state is the field after the name, whose parentheses can hold spaces
        assert!(zombie("812 (valkey-server) Z 1 812 812 0 -1"));
        assert!(!zombie("813 (valkey-server) S 1 813 813 0 -1"));
        assert!(!zombie("814 (a) Z) S 1"));
    }

    #[test]
    fn a_resp_command_is_an_array_of_bulk_strings() {
        let args: Vec<String> = ["SENTINEL", "FAILOVER", "mymaster"].iter().map(|a| a.to_string()).collect();
        assert_eq!(
            resp_command(&args),
            b"*3\r\n$8\r\nSENTINEL\r\n$8\r\nFAILOVER\r\n$8\r\nmymaster\r\n".to_vec()
        );
    }

    #[test]
    fn a_query_is_a_startup_message_and_a_simple_query() {
        // the length counts itself, then the protocol 3.0, then each pair, then a final zero
        let startup = pg_startup("postgres", "pgbouncer");
        assert_eq!(&startup[..4], &(startup.len() as u32).to_be_bytes());
        assert_eq!(&startup[4..8], &[0, 3, 0, 0]);
        assert_eq!(&startup[8..], b"user\0postgres\0database\0pgbouncer\0\0");
        assert_eq!(pg_message(b'Q', b"PAUSE\0"), b"Q\0\0\0\x0aPAUSE\0".to_vec());
        assert_eq!(pg_message(b'X', &[]), b"X\0\0\0\x04".to_vec());
        let mut reply: &[u8] = b"Z\0\0\0\x05I";
        assert_eq!(pg_read(&mut reply).unwrap(), (b'Z', b"I".to_vec()));
        let mut short: &[u8] = b"Z\0\0\0\x03";
        assert!(pg_read(&mut short).is_err());
        assert_eq!(pg_error(b"SERROR\0C08P01\0Mno such command\0\0"), "no such command");
    }

    #[test]
    fn http_requests_take_only_a_method_a_path_and_a_length() {
        assert!(http_path("/proxies/redis/toxics").is_ok());
        for path in ["proxies", "/a b", "/a;b", "/a?b=1", "/$(x)"] {
            assert!(http_path(path).is_err(), "{path}");
        }
        let request = http_request("POST", "10.0.0.3:8474", "/proxies/redis/toxics", "{}").unwrap();
        assert!(request.starts_with("POST /proxies/redis/toxics HTTP/1.1\r\n"));
        assert!(request.contains("Content-Length: 2\r\n"));
        assert!(request.ends_with("\r\n\r\n{}"));
        assert!(http_request("PUT", "h", "/", "").is_err());
    }
}
