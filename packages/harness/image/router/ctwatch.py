#!/usr/bin/env python3
"""The conntrack events of the router, as JSON lines on the monotonic clock.

Each line is {"ev": "ct", "t": <CLOCK_MONOTONIC ns>, "type": "NEW|UPDATE|DESTROY", "state": ...,
"orig": "src:sport>dst:dport", "reply": "..."}. The stamp is the time that this process read the
event, which is within a millisecond of the kernel. A listing every PUMP seconds evicts the expired
entries that it walks past, thus a DESTROY follows an expiry within PUMP plus two listings. A
listing that takes longer than SLOW seconds writes a "pump-slow" line with its start and its
length: near it, that bound of the lag does not hold.

  ctwatch.py [--pump SECONDS] [--slow SECONDS]
"""
import argparse, json, re, subprocess, sys, threading, time

p = argparse.ArgumentParser()
p.add_argument("--pump", type=float, default=0.1)
p.add_argument("--slow", type=float, default=0.02)
a = p.parse_args()

PAT = re.compile(
    r"\[(?P<type>NEW|UPDATE|DESTROY)\]\s+tcp\s+\d+\s+(?:\d+\s+)?(?P<state>[A-Z_]+)?\s*"
    r"src=(?P<s>\S+) dst=(?P<d>\S+) sport=(?P<sp>\d+) dport=(?P<dp>\d+).*?"
    r"src=(?P<rs>\S+) dst=(?P<rd>\S+) sport=(?P<rsp>\d+) dport=(?P<rdp>\d+)"
)
lock = threading.Lock()


def now():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def emit(**fields):
    with lock:
        print(json.dumps({"t": now(), **fields}), flush=True)


def pump():
    while True:
        start = now()
        subprocess.run(["conntrack", "-L", "-p", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        took = (now() - start) / 1e9
        if took > a.slow:
            with lock:
                print(json.dumps({"ev": "pump-slow", "t": start, "took": took}), flush=True)
        time.sleep(a.pump)


if a.pump > 0:
    threading.Thread(target=pump, daemon=True).start()
proc = subprocess.Popen(
    ["conntrack", "-E", "-p", "tcp"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
)
emit(ev="ct-watch", pump=a.pump, slow=a.slow)
for line in proc.stdout:
    m = PAT.search(line)
    if m is None:
        emit(ev="ct-unparsed", line=line.strip())
        continue
    emit(
        ev="ct",
        type=m["type"],
        state=m["state"],
        orig=f'{m["s"]}:{m["sp"]}>{m["d"]}:{m["dp"]}',
        reply=f'{m["rs"]}:{m["rsp"]}>{m["rd"]}:{m["rdp"]}',
    )
sys.exit(proc.wait())
