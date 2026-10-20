// Command client-go is the Go client of the HTTP cells: the http.Transport of Go 1.27.2 at its
// defaults, with each setting that a cell gives over them. Each event is a JSON line with `ev` and
// `t`, the CLOCK_MONOTONIC time in nanoseconds, as the TCP client of the harness writes them.
//
//	client-go HOST PORT --mode idle|inflight|gap [--gap-ms N] [--method GET|POST] [--hold-ms N]
//	          [--bytes N] [--go PATH] [--max-s N] [--linger-ms N]
//	          [--idle-conn-timeout-ms N] [--max-idle-per-host N] [--dial-timeout-ms N]
//	          [--keepalive-ms N] [--keepalive-interval-ms N] [--keepalive-count N] [--timeout-ms N]
//	          [--limiter-key 1]
//
// The cells of a keyed limiter give --limiter-key 1: each request sends a key of this process in
// x-limiter-key, the key of the limiter of the server. Go sends no request again for a status.
//
// The first request is GET /, and the end of its reply is the ready line. Then the client holds
// the connection idle (idle), sends the second request when the file --go appears (inflight), or
// sends it after the gap (gap).
//
// A wrapper on each connection writes what the read loop of the transport reads: an end of file,
// or an error. The trace of the transport writes which connection each request goes on, whether
// the transport reused it, and each new try of a request on a new connection.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var out sync.Mutex

// limiterKey is the key of this process for the limiter of the server, in x-limiter-key, or empty
var limiterKey string

// now gives the time on CLOCK_MONOTONIC in nanoseconds: the clock of the prober.
func now() int64 {
	var ts syscall.Timespec
	syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	return ts.Nano()
}

// emitAt writes one line with the time t.
func emitAt(ev string, t int64, fields map[string]any) {
	line := map[string]any{"ev": ev, "t": t}
	for key, value := range fields {
		line[key] = value
	}
	bytes, _ := json.Marshal(line)
	out.Lock()
	os.Stdout.Write(append(bytes, '\n'))
	out.Unlock()
}

// emit writes one line with the time now.
func emit(ev string, fields map[string]any) { emitAt(ev, now(), fields) }

var names = map[syscall.Errno]string{
	syscall.ECONNRESET:   "ECONNRESET",
	syscall.ECONNREFUSED: "ECONNREFUSED",
	syscall.ETIMEDOUT:    "ETIMEDOUT",
	syscall.EHOSTUNREACH: "EHOSTUNREACH",
	syscall.ENETUNREACH:  "ENETUNREACH",
	syscall.EPIPE:        "EPIPE",
	syscall.ECONNABORTED: "ECONNABORTED",
}

// errnoOf gives the name of the error of a socket, EOF for an end of file, or TIMEOUT for a
// deadline of Go.
func errnoOf(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name, ok := names[errno]; ok {
			return name
		}
		return fmt.Sprintf("E%d", int(errno))
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "EOF"
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "TIMEOUT"
	}
	return "ERROR"
}

// traced is a connection that writes what its reads end with, and its close.
type traced struct {
	net.Conn
	local  string
	mu     sync.Mutex
	closed bool
}

func (c *traced) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil {
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		// a read after the close of the client itself is not an event of the peer
		if !closed {
			if errors.Is(err, io.EOF) {
				emit("eof", map[string]any{"local": c.local})
			} else {
				emit("conn-error", map[string]any{"local": c.local, "errno": errnoOf(err), "message": err.Error()})
			}
		}
	}
	return n, err
}

func (c *traced) Close() error {
	c.mu.Lock()
	first := !c.closed
	c.closed = true
	c.mu.Unlock()
	if first {
		emit("closed", map[string]any{"local": c.local})
	}
	return c.Conn.Close()
}

// dial gives the DialContext of the transport: the dialer, and a wrapper on each connection.
func dial(d *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	var mu sync.Mutex
	count := 0
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		start := now()
		conn, err := d.DialContext(ctx, network, addr)
		if err != nil {
			emit("dial-error", map[string]any{"errno": errnoOf(err), "message": err.Error(), "ns": now() - start})
			return nil, err
		}
		mu.Lock()
		count++
		n := count
		mu.Unlock()
		local := conn.LocalAddr().String()
		emit("conn", map[string]any{"n": n, "local": local})
		if n == 1 {
			emit("connected", map[string]any{"local": local})
		}
		return &traced{Conn: conn, local: local}, nil
	}
}

// request sends request i and waits for its outcome. It tells whether a reply came.
func request(client *http.Client, base string, i int, method, path string) bool {
	attempts := 0
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			attempts++
			ev := "request"
			if attempts > 1 {
				ev = "retry"
			}
			emit(ev, map[string]any{
				"i":       i,
				"local":   info.Conn.LocalAddr().String(),
				"reused":  info.Reused,
				"idle_ns": info.IdleTime.Nanoseconds(),
			})
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			fields := map[string]any{"i": i}
			if info.Err != nil {
				fields["errno"] = errnoOf(info.Err)
			}
			emit("wrote", fields)
		},
		GotFirstResponseByte: func() { emit("first-byte", map[string]any{"i": i}) },
	}
	var body io.Reader
	if method == "POST" {
		body = strings.NewReader("x")
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), method, base+path, body)
	if err != nil {
		emit("fail", map[string]any{"why": err.Error()})
		os.Exit(1)
	}
	if limiterKey != "" {
		req.Header.Set("x-limiter-key", limiterKey)
	}
	// the stamp comes before the call: the transport writes the request after it
	at := now()
	emitAt("sent", at, map[string]any{"i": i})
	resp, err := client.Do(req)
	if err != nil {
		emit("error", map[string]any{"i": i, "errno": errnoOf(err), "message": err.Error()})
		return false
	}
	emit("response", map[string]any{"i": i, "status": resp.StatusCode})
	n, err := io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if err != nil {
		emit("error", map[string]any{"i": i, "errno": errnoOf(err), "message": err.Error()})
		return false
	}
	if i == 1 {
		emit("ready", map[string]any{"reply": resp.Status})
	} else {
		emit("data", map[string]any{"i": i, "n": n})
		emit("replied", map[string]any{"i": i, "n": map[string]any{"value": n, "unit": "B"}})
	}
	return true
}

func milliseconds(ms float64) time.Duration { return time.Duration(ms * float64(time.Millisecond)) }

func main() {
	usage := "client-go HOST PORT --mode idle|inflight|gap"
	if len(os.Args) < 3 {
		emit("fail", map[string]any{"why": usage})
		os.Exit(1)
	}
	host, port := os.Args[1], os.Args[2]
	flags := flag.NewFlagSet("client-go", flag.ExitOnError)
	mode := flags.String("mode", "", "idle, inflight or gap")
	gapMs := flags.Float64("gap-ms", 0, "the gap after the first reply, in gap mode")
	method := flags.String("method", "GET", "the method of the second request")
	holdMs := flags.Int("hold-ms", 0, "the second request asks the server to hold its reply")
	size := flags.Int("bytes", 0, "the second request asks for a body of this length")
	goPath := flags.String("go", "/tmp/go", "the file that starts the second request, in inflight mode")
	maxS := flags.Float64("max-s", 60, "the deadline of the client")
	lingerMs := flags.Float64("linger-ms", 500, "the wait after the second request, before the exit")
	idleMs := flags.Float64("idle-conn-timeout-ms", 0, "Transport.IdleConnTimeout")
	maxIdle := flags.Int("max-idle-per-host", 0, "Transport.MaxIdleConnsPerHost")
	dialMs := flags.Float64("dial-timeout-ms", 0, "Dialer.Timeout")
	keepAliveMs := flags.Float64("keepalive-ms", 0, "Dialer.KeepAlive, negative for off")
	intervalMs := flags.Float64("keepalive-interval-ms", 0, "KeepAliveConfig.Interval")
	probes := flags.Int("keepalive-count", 0, "KeepAliveConfig.Count")
	timeoutMs := flags.Float64("timeout-ms", 0, "Client.Timeout")
	keyed := flags.Int("limiter-key", 0, "1 sends a key of this process in x-limiter-key: the key of the limiter of the server")
	flags.Parse(os.Args[3:])
	if *keyed == 1 {
		limiterKey = fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	given := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if *mode != "idle" && *mode != "inflight" && *mode != "gap" {
		emit("fail", map[string]any{"why": usage})
		os.Exit(1)
	}

	// the dialer of http.DefaultTransport (src/net/http/transport.go:47-53), with the settings of the cell
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	if given["dial-timeout-ms"] {
		dialer.Timeout = milliseconds(*dialMs)
	}
	if given["keepalive-ms"] {
		dialer.KeepAlive = milliseconds(*keepAliveMs)
	}
	if given["keepalive-interval-ms"] || given["keepalive-count"] {
		dialer.KeepAliveConfig = net.KeepAliveConfig{
			Enable:   dialer.KeepAlive >= 0,
			Idle:     dialer.KeepAlive,
			Interval: milliseconds(*intervalMs),
			Count:    *probes,
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dial(dialer)
	if given["idle-conn-timeout-ms"] {
		transport.IdleConnTimeout = milliseconds(*idleMs)
	}
	if given["max-idle-per-host"] {
		transport.MaxIdleConnsPerHost = *maxIdle
	}
	client := &http.Client{Transport: transport}
	if given["timeout-ms"] {
		client.Timeout = milliseconds(*timeoutMs)
	}

	bootID, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	settings := map[string]any{}
	settings["IdleConnTimeout_ms"] = transport.IdleConnTimeout.Milliseconds()
	settings["MaxIdleConnsPerHost"] = transport.MaxIdleConnsPerHost
	settings["DialTimeout_ms"] = dialer.Timeout.Milliseconds()
	settings["KeepAlive_ms"] = dialer.KeepAlive.Milliseconds()
	settings["KeepAliveInterval_ms"] = dialer.KeepAliveConfig.Interval.Milliseconds()
	settings["KeepAliveCount"] = dialer.KeepAliveConfig.Count
	settings["ClientTimeout_ms"] = client.Timeout.Milliseconds()
	start := map[string]any{}
	start["boot_id"] = strings.TrimSpace(string(bootID))
	start["mode"] = *mode
	start["client"] = "go-nethttp"
	start["go"] = runtime.Version()
	start["settings"] = settings
	emit("start", start)
	go func() {
		time.Sleep(time.Duration(*maxS * float64(time.Second)))
		emit("deadline", nil)
		os.Exit(0)
	}()

	base := "http://" + net.JoinHostPort(host, port)
	second := "/"
	if *holdMs > 0 {
		second = fmt.Sprintf("/hold?ms=%d", *holdMs)
	} else if *size > 0 {
		second = fmt.Sprintf("/big?bytes=%d", *size)
	}
	if !request(client, base, 1, "GET", "/") {
		os.Exit(1)
	}
	switch *mode {
	case "idle":
		// the connection stays in the pool until it ends, or until the deadline
		select {}
	case "inflight":
		for {
			if _, err := os.Stat(*goPath); err == nil {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}
	case "gap":
		time.Sleep(milliseconds(*gapMs))
	}
	request(client, base, 2, *method, second)
	emit("done", map[string]any{"i": 2})
	time.Sleep(milliseconds(*lingerMs))
	os.Exit(0)
}
