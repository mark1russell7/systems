// Command etcd-kv is the client of the read cells of etcd (SYS-75). It is clientv3 of etcd v3.6.15.
// Each worker has its own client with one endpoint: worker i talks to member i of the list, modulo
// its length. Thus a fault on one member always meets the workers of that member.
//
// Each worker puts a unique value or gets a key, on keys under a prefix of the run. It writes one
// line for each operation, with the times of its call and of its response on CLOCK_MONOTONIC in
// nanoseconds. The lines give the history that the checker of linearizability reads:
//
//   - A put with no response is unknown: it can take effect after its call. The worker then takes a
//     new client number, as a process of Jepsen does after an indeterminate operation.
//   - A get with an error failed: a read has no effect.
//
// The other lines are start (the versions and the options), clocks (the wall clock each second),
// ready (after the first operation with a response) and done (at the end).
//
//	etcd-kv <endpoints> --prefix r0-0- --clients 6 --keys 8 --interval-ms 20 --max-s 120 \
//	  --reads linearizable --timeout-ms 1000 --seed 1
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.uber.org/zap"
)

var out sync.Mutex

// now gives the time on CLOCK_MONOTONIC in nanoseconds: the clock of the prober.
func now() int64 {
	var ts syscall.Timespec
	syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	return ts.Nano()
}

// emit writes one line with the time now.
func emit(ev string, fields map[string]any) {
	line := map[string]any{"ev": ev, "t": now()}
	for key, value := range fields {
		line[key] = value
	}
	bytes, _ := json.Marshal(line)
	out.Lock()
	os.Stdout.Write(append(bytes, '\n'))
	out.Unlock()
}

// versions gives the version of each module of etcd and of gRPC in the build of this program.
func versions() map[string]string {
	found := map[string]string{"go": "unknown"}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return found
	}
	found["go"] = info.GoVersion
	for _, dep := range info.Deps {
		if strings.HasPrefix(dep.Path, "go.etcd.io/") || dep.Path == "google.golang.org/grpc" {
			found[dep.Path] = dep.Version
		}
	}
	return found
}

// options are the settings of a run, from the flags.
type options struct {
	endpoints    []string
	prefix       string
	clients      int
	keys         int
	interval     time.Duration
	max          time.Duration
	serializable bool
	timeout      time.Duration
	seed         uint64
}

func parse(args []string) (options, error) {
	if len(args) < 1 || strings.HasPrefix(args[0], "-") {
		return options{}, fmt.Errorf("the first argument is the list of endpoints")
	}
	flags := flag.NewFlagSet("etcd-kv", flag.ContinueOnError)
	prefix := flags.String("prefix", "", "the prefix of each key of the run")
	clients := flags.Int("clients", 6, "the count of workers")
	keys := flags.Int("keys", 8, "the count of keys")
	interval := flags.Int("interval-ms", 20, "the wait after each operation")
	longest := flags.Int("max-s", 120, "the longest run")
	reads := flags.String("reads", "linearizable", "linearizable or serializable")
	timeout := flags.Int("timeout-ms", 1000, "the deadline of each operation")
	seed := flags.Uint64("seed", 1, "the seed of the choices of the workers")
	if err := flags.Parse(args[1:]); err != nil {
		return options{}, err
	}
	if *reads != "linearizable" && *reads != "serializable" {
		return options{}, fmt.Errorf("--reads is linearizable or serializable, not %q", *reads)
	}
	if *prefix == "" || *clients < 1 || *keys < 1 || *timeout < 1 {
		return options{}, fmt.Errorf("--prefix, --clients, --keys and --timeout-ms need a value")
	}
	return options{
		endpoints:    strings.Split(args[0], ","),
		prefix:       *prefix,
		clients:      *clients,
		keys:         *keys,
		interval:     time.Duration(*interval) * time.Millisecond,
		max:          time.Duration(*longest) * time.Second,
		serializable: *reads == "serializable",
		timeout:      time.Duration(*timeout) * time.Millisecond,
		seed:         *seed,
	}, nil
}

func main() {
	opts, err := parse(os.Args[1:])
	if err != nil {
		emit("fail", map[string]any{"why": err.Error()})
		os.Exit(2)
	}
	reads := "linearizable"
	if opts.serializable {
		reads = "serializable"
	}
	emit("start", map[string]any{
		"versions":  versions(),
		"endpoints": opts.endpoints,
		"prefix":    opts.prefix,
		"clients":   opts.clients,
		"keys":      opts.keys,
		"interval":  opts.interval.Milliseconds(),
		"reads":     reads,
		"timeout":   opts.timeout.Milliseconds(),
		"seed":      opts.seed,
	})
	clock := func() { emit("clocks", map[string]any{"real": float64(time.Now().UnixNano()) / 1e6}) }
	clock()
	go func() {
		for range time.Tick(time.Second) {
			clock()
		}
	}()

	// a TERM or the end of the run cancels each operation in flight: its line still comes
	base, cancel := context.WithTimeout(context.Background(), opts.max)
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		cancel()
	}()

	var ready atomic.Bool
	var group sync.WaitGroup
	for worker := 0; worker < opts.clients; worker++ {
		endpoint := opts.endpoints[worker%len(opts.endpoints)]
		cli, err := clientv3.New(clientv3.Config{
			Endpoints:   []string{endpoint},
			DialTimeout: 5 * time.Second,
			Logger:      zap.NewNop(),
		})
		if err != nil {
			emit("fail", map[string]any{"why": err.Error(), "endpoint": endpoint})
			os.Exit(1)
		}
		defer cli.Close()
		group.Add(1)
		go func() {
			defer group.Done()
			work(base, cli, opts, worker, endpoint, &ready)
		}()
	}
	group.Wait()
	emit("done", map[string]any{})
}

// work does the operations of one worker until the end of the run.
func work(base context.Context, cli *clientv3.Client, opts options, worker int, endpoint string, ready *atomic.Bool) {
	rng := rand.New(rand.NewPCG(opts.seed, uint64(worker)))
	// a new client number after each unknown put: worker, then worker + clients, and so on
	client := worker
	for seq := 0; base.Err() == nil; seq++ {
		key := fmt.Sprintf("k%d", rng.IntN(opts.keys))
		ctx, done := context.WithTimeout(base, opts.timeout)
		fields := map[string]any{"worker": worker, "at": endpoint, "key": key}
		if rng.IntN(2) == 0 {
			value := fmt.Sprintf("%d-%d", worker, seq)
			fields["op"], fields["value"] = "put", value
			call := now()
			_, err := cli.Put(ctx, opts.prefix+key, value)
			back := now()
			fields["call"] = call
			if err == nil {
				fields["return"], fields["result"] = back, "ok"
			} else {
				fields["result"], fields["error"] = "unknown", err.Error()
			}
		} else {
			fields["op"] = "get"
			var reads []clientv3.OpOption
			if opts.serializable {
				reads = append(reads, clientv3.WithSerializable())
			}
			call := now()
			resp, err := cli.Get(ctx, opts.prefix+key, reads...)
			back := now()
			fields["call"], fields["return"] = call, back
			if err == nil {
				fields["result"] = "ok"
				if len(resp.Kvs) == 0 {
					fields["value"] = nil
				} else {
					fields["value"] = string(resp.Kvs[0].Value)
				}
			} else {
				fields["result"], fields["error"] = "fail", err.Error()
			}
		}
		done()
		fields["client"] = client
		if fields["result"] == "unknown" {
			client += opts.clients
		}
		emit("op", fields)
		if fields["result"] != "unknown" && fields["result"] != "fail" && !ready.Swap(true) {
			emit("ready", map[string]any{})
		}
		select {
		case <-base.Done():
		case <-time.After(opts.interval):
		}
	}
}
