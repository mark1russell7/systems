// Package main is the prober's collector in Go, one of three over one record contract
// (packages/prober/README.md). It decodes `struct ev` (bpf/prober.h) and prints the line the Rust
// collector prints, byte for byte: serde_json's sorted keys, its escapes, and Rust's lossy UTF-8.
package main

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Size is struct ev's size in bytes: seven u64, five u32, seven i32, two u16, two u32, struct
// tcp_now (nine u32), struct seg (four u32), two u32 for a timer and a 16-byte comm, with no
// padding.
const Size = 192

// kinds are the event kinds, in prober.h's order, from 1.
var kinds = [...]string{
	"state", "accept", "retrans", "rst_tx", "rst_rx", "error", "destroy", "tw_enter", "tw_kill",
	"req_new", "rst_v4", "probe", "rx", "timer",
}

// icskTimeLossProbe is ICSK_TIME_LOSS_PROBE: the tail loss probe is armed.
const icskTimeLossProbe = 5

// timerOwned is prober.h's TIMER_OWNED: a timer record's flag that the socket's owner held it.
const timerOwned = 0x100

type tcpNow struct {
	retransmits, pending, backoff, probesOut, rto, srttUs, sndUna, sndNxt, rcvNxt uint32
}

type seg struct{ seq, ack, len, flags uint32 }

// ev is one record, as the kernel wrote it.
type ev struct {
	mono, tai, cookie, nscookie, cgid, skaddr, ino uint64
	kind, netns                                    uint32
	saddr, daddr                                   [4]byte
	extra                                          uint32
	pid, fd, oldst, newst, state, err, owner       int32
	sport, dport                                   uint16
	tcp                                            *tcpNow
	seg                                            *seg
	behind, late                                   uint32
	comm                                           []byte
}

// decode reads one ring-buffer record field by field, native-endian, or says why it cannot.
func decode(b []byte) (*ev, error) {
	if len(b) != Size {
		return nil, fmt.Errorf("a record is %d bytes, not %d", Size, len(b))
	}
	at := 0
	u64 := func() uint64 { v := binary.NativeEndian.Uint64(b[at:]); at += 8; return v }
	u32 := func() uint32 { v := binary.NativeEndian.Uint32(b[at:]); at += 4; return v }
	i32 := func() int32 { return int32(u32()) }
	u16 := func() uint16 { v := binary.NativeEndian.Uint16(b[at:]); at += 2; return v }
	addr := func() (a [4]byte) { copy(a[:], b[at:at+4]); at += 4; return }
	e := &ev{}
	e.mono, e.tai, e.cookie, e.nscookie, e.cgid, e.skaddr, e.ino = u64(), u64(), u64(), u64(), u64(), u64(), u64()
	e.kind, e.netns = u32(), u32()
	e.saddr, e.daddr = addr(), addr()
	e.extra = u32()
	e.pid, e.fd, e.oldst, e.newst, e.state, e.err, e.owner = i32(), i32(), i32(), i32(), i32(), i32(), i32()
	e.sport, e.dport = u16(), u16()
	hasTCP, hasSeg := u32(), u32()
	t := tcpNow{u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32()}
	s := seg{u32(), u32(), u32(), u32()}
	e.behind, e.late = u32(), u32()
	comm := b[at : at+16]
	end := 16
	for i, c := range comm {
		if c == 0 {
			end = i
			break
		}
	}
	e.comm = comm[:end]
	if hasTCP != 0 {
		e.tcp = &t
	}
	if hasSeg != 0 {
		e.seg = &s
	}
	return e, nil
}

func (e *ev) kindName() string {
	if e.kind >= 1 && int(e.kind) <= len(kinds) {
		return kinds[e.kind-1]
	}
	return "unknown"
}

// retransmission says what a retransmission was: the tail loss probe, the RTO timer's, or one
// from ACK processing; "" when the record carries no TCP state.
func (e *ev) retransmission() string {
	switch {
	case e.tcp == nil:
		return ""
	case e.tcp.pending == icskTimeLossProbe:
		return "tlp"
	case e.tcp.pending == 0 && e.tcp.retransmits > 0:
		return "rto"
	default:
		return "fast"
	}
}

// replacement is U+FFFD, the character a broken UTF-8 sequence becomes.
const replacement = "\xef\xbf\xbd"

// appendLossyQuoted appends raw bytes as a JSON string, decoded as Rust's
// String::from_utf8_lossy decodes them: each maximal prefix of a would-be UTF-8 sequence that
// cannot complete becomes one U+FFFD, and decoding resumes at the byte that broke it. ASCII is
// escaped as serde_json escapes it.
func appendLossyQuoted(out []byte, b []byte) []byte {
	out = append(out, '"')
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out = appendEscaped(out, c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c == 0xED:
			need, hi = 2, 0x9F
		case c >= 0xE1 && c <= 0xEF:
			need = 2
		case c == 0xF0:
			need, lo = 3, 0x90
		case c == 0xF4:
			need, hi = 3, 0x8F
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		default:
			out = append(out, replacement...)
			i++
			continue
		}
		j, ok := i+1, true
		for k := 0; k < need; k++ {
			if j >= len(b) {
				ok = false
				break
			}
			first, last := byte(0x80), byte(0xBF)
			if k == 0 {
				first, last = lo, hi
			}
			if b[j] < first || b[j] > last {
				ok = false
				break
			}
			j++
		}
		if ok {
			out = append(out, b[i:j]...)
		} else {
			out = append(out, replacement...)
		}
		i = j
	}
	return append(out, '"')
}

// appendEscaped appends one byte of a JSON string as serde_json writes it: \" \\ \b \f \n \r \t,
// other control characters as \u00xx in lowercase hex, and everything else as it is.
func appendEscaped(out []byte, c byte) []byte {
	const hex = "0123456789abcdef"
	switch c {
	case '"':
		return append(out, `\"`...)
	case '\\':
		return append(out, `\\`...)
	case '\b':
		return append(out, `\b`...)
	case '\f':
		return append(out, `\f`...)
	case '\n':
		return append(out, `\n`...)
	case '\r':
		return append(out, `\r`...)
	case '\t':
		return append(out, `\t`...)
	}
	if c < 0x20 {
		return append(out, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xF])
	}
	return append(out, c)
}

// quote writes a JSON string as serde_json does.
func quote(out *strings.Builder, s string) {
	var b []byte
	b = append(b, '"')
	for k := 0; k < len(s); k++ {
		b = appendEscaped(b, s[k])
	}
	out.Write(append(b, '"'))
}

// object is a JSON object as serde_json's Value writes one: its keys sorted, because its map is a
// BTreeMap. Each value is already JSON.
type object []struct{ key, value string }

func (o *object) set(key, value string) { *o = append(*o, struct{ key, value string }{key, value}) }

func (o object) String() string {
	sort.Slice(o, func(a, b int) bool { return o[a].key < o[b].key })
	var out strings.Builder
	out.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			out.WriteByte(',')
		}
		quote(&out, kv.key)
		out.WriteByte(':')
		out.WriteString(kv.value)
	}
	out.WriteByte('}')
	return out.String()
}

func jsonString(s string) string {
	var out strings.Builder
	quote(&out, s)
	return out.String()
}

func u(v uint64) string { return strconv.FormatUint(v, 10) }
func i(v int32) string  { return strconv.FormatInt(int64(v), 10) }

func appendU32(b []byte, v uint32) []byte { return strconv.AppendUint(b, uint64(v), 10) }
func appendI32(b []byte, v int32) []byte  { return strconv.AppendInt(b, int64(v), 10) }

// appendQuantity is `{"unit":"…","value":N.0}`: every amount a record carries is a whole u32,
// which serde writes as a float.
func appendQuantity(b []byte, value uint32, unit string) []byte {
	b = append(b, `{"unit":"`...)
	b = append(b, unit...)
	b = append(b, `","value":`...)
	b = appendU32(b, value)
	return append(b, `.0}`...)
}

// appendEndpoint is `"a.b.c.d:port"`.
func appendEndpoint(b []byte, a [4]byte, port uint16) []byte {
	b = append(b, '"')
	for k, octet := range a {
		if k > 0 {
			b = append(b, '.')
		}
		b = strconv.AppendUint(b, uint64(octet), 10)
	}
	b = append(b, ':')
	b = strconv.AppendUint(b, uint64(port), 10)
	return append(b, '"')
}

// appendLine appends the record's JSON line, leaving out what is absent, with its keys in byte
// order as serde_json writes them: straight into the buffer, building nothing per record.
func (e *ev) appendLine(b []byte) []byte {
	name := e.kindName()
	b = append(b, '{')
	if name == "rst_tx" {
		b = append(b, `"active":`...)
		b = strconv.AppendBool(b, e.extra == 1)
		b = append(b, ',')
	}
	if name == "timer" {
		b = append(b, `"behind":`...)
		b = appendQuantity(b, e.behind, "jiffy")
		b = append(b, ',')
	}
	b = append(b, `"cg":`...)
	b = strconv.AppendUint(b, e.cgid, 10)
	b = append(b, `,"comm":`...)
	b = appendLossyQuoted(b, e.comm)
	b = append(b, `,"cookie":`...)
	b = strconv.AppendUint(b, e.cookie, 10)
	b = append(b, `,"dst":`...)
	b = appendEndpoint(b, e.daddr, e.dport)
	b = append(b, `,"err":`...)
	b = appendI32(b, e.err)
	b = append(b, `,"ev":"`...)
	b = append(b, name...)
	b = append(b, '"')
	if e.owner != 0 {
		b = append(b, `,"fd":`...)
		b = appendI32(b, e.fd)
	}
	if name == "timer" {
		b = append(b, `,"late":`...)
		b = appendQuantity(b, e.late, "jiffy")
	}
	b = append(b, `,"mono":`...)
	b = strconv.AppendUint(b, e.mono, 10)
	b = append(b, `,"netns":`...)
	b = appendU32(b, e.netns)
	if name == "state" {
		b = append(b, `,"new":`...)
		b = appendI32(b, e.newst)
		b = append(b, `,"old":`...)
		b = appendI32(b, e.oldst)
	}
	if name == "timer" {
		b = append(b, `,"owned":`...)
		b = strconv.AppendBool(b, e.extra&timerOwned != 0)
	}
	b = append(b, `,"pid":`...)
	b = appendI32(b, e.pid)
	if s := e.seg; s != nil {
		b = append(b, `,"seg":{`...)
		if name == "rx" {
			b = append(b, `"ack":`...)
			b = appendU32(b, s.ack)
			b = append(b, `,"flags":`...)
			b = appendU32(b, s.flags)
			b = append(b, ',')
		}
		b = append(b, `"len":`...)
		b = appendQuantity(b, s.len, "B")
		b = append(b, `,"seq":`...)
		b = appendU32(b, s.seq)
		b = append(b, '}')
	}
	b = append(b, `,"src":`...)
	b = appendEndpoint(b, e.saddr, e.sport)
	b = append(b, `,"state":`...)
	b = appendI32(b, e.state)
	if e.tai != 0 {
		b = append(b, `,"tai":`...)
		b = strconv.AppendUint(b, e.tai, 10)
	}
	if t := e.tcp; t != nil {
		b = append(b, `,"tcp":{"backoff":`...)
		b = appendU32(b, t.backoff)
		b = append(b, `,"pending":`...)
		b = appendU32(b, t.pending)
		b = append(b, `,"probes_out":`...)
		b = appendU32(b, t.probesOut)
		b = append(b, `,"rcv_nxt":`...)
		b = appendU32(b, t.rcvNxt)
		b = append(b, `,"retransmits":`...)
		b = appendU32(b, t.retransmits)
		b = append(b, `,"rto":`...)
		b = appendQuantity(b, t.rto, "jiffy")
		b = append(b, `,"snd_nxt":`...)
		b = appendU32(b, t.sndNxt)
		b = append(b, `,"snd_una":`...)
		b = appendU32(b, t.sndUna)
		b = append(b, `,"srtt":`...)
		b = appendQuantity(b, t.srttUs, "us")
		b = append(b, '}')
	}
	if name == "probe" || name == "timer" {
		// a timer's kind is its extra's low byte, beside the owned flag
		kind := e.extra
		if name == "timer" {
			kind &= 0xff
		}
		what := "other"
		switch {
		case kind == 1:
			what = "keepalive"
		case kind == 2 && name == "probe":
			what = "window"
		case kind == 2:
			what = "retransmit"
		}
		b = append(b, `,"what":"`...)
		b = append(b, what...)
		b = append(b, '"')
	}
	if name == "retrans" {
		if why := e.retransmission(); why != "" {
			b = append(b, `,"why":"`...)
			b = append(b, why...)
			b = append(b, '"')
		}
	}
	switch name {
	case "error", "tw_enter", "tw_kill", "req_new", "rst_v4":
		b = append(b, `,"x":`...)
		b = appendU32(b, e.extra)
	}
	return append(b, '}')
}

// undecodable is the line for a record that is not one.
func undecodable(why error) string {
	var o object
	o.set("ev", jsonString("undecodable"))
	o.set("why", jsonString(why.Error()))
	return o.String()
}
