#!/usr/bin/env python3
"""The reset at expiry: the form of a middlebox that resets the two ends when it forgets a flow.

It listens to the DESTROY events of conntrack in this namespace. For each destroyed TCP flow that
it saw carry traffic, and never saw closed (FIN or RST), it sends a reset to each end. Each reset
has the sequence number that its end expects: the last acknowledgment number that the end sent,
read by a raw sniffer on the interfaces, because conntrack events carry no sequence numbers.
Each line is JSON on the monotonic clock: {"ev": "reset", "t": ..., "flow": ..., "to": [...]}.

  resetter.py IFACE [IFACE...]
"""
import argparse, json, re, socket, struct, subprocess, threading, time

p = argparse.ArgumentParser()
p.add_argument("ifaces", nargs="+")
a = p.parse_args()

plock = threading.Lock()
flock = threading.Lock()
flows = {}  # (src, sport, dst, dport) -> {"ack", "closed"}


def emit(**fields):
    with plock:
        print(json.dumps({"t": time.clock_gettime_ns(time.CLOCK_MONOTONIC), **fields}), flush=True)


def sniff(ifname):
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0800))
    s.bind((ifname, 0))
    while True:
        pkt = s.recv(65535)
        ip = pkt[14:]
        if len(ip) < 40 or ip[0] >> 4 != 4 or ip[9] != 6:
            continue
        ihl = (ip[0] & 0xF) * 4
        src, dst = socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20])
        tcp = ip[ihl:]
        sport, dport, _seq, ack = struct.unpack("!HHII", tcp[:12])
        fl = tcp[13]
        with flock:
            f = flows.setdefault((src, sport, dst, dport), {"ack": None, "closed": False})
            if fl & 0x10:
                f["ack"] = ack
            if fl & 0x05:
                f["closed"] = True


raw = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)


def csum(b):
    if len(b) % 2:
        b += b"\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF


def send_rst(src, sport, dst, dport, seq):
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, 0, 5 << 4, 0x04, 0, 0, 0)
    pseudo = socket.inet_aton(src) + socket.inet_aton(dst) + struct.pack("!BBH", 0, 6, len(tcp))
    tcp = tcp[:16] + struct.pack("!H", csum(pseudo + tcp)) + tcp[18:]
    iph = struct.pack(
        "!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), 0, 0x4000, 64, 6, 0, socket.inet_aton(src), socket.inet_aton(dst)
    )
    raw.sendto(iph + tcp, (dst, 0))


PAT = re.compile(r"src=(\S+) dst=(\S+) sport=(\d+) dport=(\d+) .*?src=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)")


def main():
    for i in a.ifaces:
        threading.Thread(target=sniff, args=(i,), daemon=True).start()
    proc = subprocess.Popen(
        ["conntrack", "-E", "-e", "DESTROY", "-p", "tcp"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
    )
    emit(ev="resetter", ifaces=a.ifaces)
    for line in proc.stdout:
        m = PAT.search(line)
        if not m:
            continue
        c, s, cp, sp, s2, r, sp2, rp = m.groups()
        cp, sp, sp2, rp = int(cp), int(sp), int(sp2), int(rp)
        k_cs, k_sr = (c, cp, s, sp), (s2, sp2, r, rp)
        with flock:
            fs = {k: dict(flows[k]) for k in (k_cs, (s, sp, c, cp), (r, rp, s2, sp2), k_sr) if k in flows}
        if not fs or any(f["closed"] for f in fs.values()):
            continue
        seq_c = fs.get(k_cs, {}).get("ack")  # the RCV.NXT of the client
        seq_s = fs.get(k_sr, {}).get("ack")  # the RCV.NXT of the server, on the translated side
        sent = []
        if seq_c is not None:
            send_rst(s, sp, c, cp, seq_c)
            sent.append("client")
        if seq_s is not None:
            send_rst(r, rp, s2, sp2, seq_s)
            sent.append("server")
        emit(ev="reset", flow=f"{c}:{cp}>{s}:{sp}", nat=f"{r}:{rp}", to=sent)


main()
