// Command grpc-go-server is the server of the gRPC cells: a server of grpc-go v1.84.0 on its own
// listener, at the defaults of grpc-go, with each setting that a cell gives over them. Each event is a
// JSON line with `ev` and `t`, the CLOCK_MONOTONIC time in nanoseconds, as the clients of the harness
// write them.
//
//	grpc-go-server [--port N] [--keepalive-time D] [--keepalive-timeout D] [--min-time D]
//	               [--permit-without-stream] [--max-connection-idle D] [--max-connection-age D]
//	               [--max-connection-age-grace D] [--listener-keepalive D]
//	               [--listener-keepalive-interval D] [--listener-keepalive-count N]
//
// Each D is a duration of Go, for example 20s. A setting at 0 is the default of grpc-go or of Go. A
// negative --listener-keepalive turns the TCP keepalive of the accepted connections off.
//
// The server serves grpc.health.v1.Health. Check of the service "" answers SERVING at once. Check of
// "hold:<ms>" holds its reply for that time, or until the client ends the call. Any other service is
// NOT_FOUND. Watch sends SERVING and then holds the stream open until the client ends it.
//
// The lines: listening (the ready line of the target), accept (each connection, with its addresses),
// hold, held and hold-ended (a held reply), watch and watch-ended, and stopping.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
)

// now gives the time on CLOCK_MONOTONIC in nanoseconds: the clock of the prober.
func now() int64 {
	var ts syscall.Timespec
	syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	return ts.Nano()
}

// emit writes one JSON line with its event and its time.
func emit(ev string, fields map[string]any) {
	line := map[string]any{"ev": ev, "t": now()}
	for name, value := range fields {
		line[name] = value
	}
	out, err := json.Marshal(line)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(append(out, '\n'))
}

// health is the health service of the server, with a held reply for a cell.
type health struct {
	healthpb.UnimplementedHealthServer
}

func (health) Check(ctx context.Context, request *healthpb.HealthCheckRequest) (*healthpb.HealthCheckResponse, error) {
	service := request.GetService()
	if service == "" {
		return &healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_SERVING}, nil
	}
	text, ok := strings.CutPrefix(service, "hold:")
	if !ok {
		return nil, status.Error(codes.NotFound, "unknown service")
	}
	ms, err := strconv.Atoi(text)
	if err != nil || ms < 0 {
		return nil, status.Error(codes.InvalidArgument, "the service hold:<ms> needs a whole number of milliseconds")
	}
	emit("hold", map[string]any{"ms": ms})
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		emit("held", map[string]any{"ms": ms})
		return &healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_SERVING}, nil
	case <-ctx.Done():
		emit("hold-ended", map[string]any{"ms": ms, "why": ctx.Err().Error()})
		return nil, status.FromContextError(ctx.Err()).Err()
	}
}

func (health) Watch(request *healthpb.HealthCheckRequest, stream healthpb.Health_WatchServer) error {
	emit("watch", map[string]any{"service": request.GetService()})
	if err := stream.Send(&healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_SERVING}); err != nil {
		return err
	}
	<-stream.Context().Done()
	emit("watch-ended", map[string]any{"why": stream.Context().Err().Error()})
	return nil
}

// listener writes a line for each accepted connection. It gives grpc-go the *net.TCPConn itself,
// thus grpc-go can set TCP_USER_TIMEOUT on it (internal/syscall/syscall_linux.go).
type listener struct {
	net.Listener
}

func (l listener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	emit("accept", map[string]any{"local": conn.LocalAddr().String(), "remote": conn.RemoteAddr().String()})
	return conn, nil
}

func main() {
	port := flag.Int("port", 50051, "the port of the listener")
	keepaliveTime := flag.Duration("keepalive-time", 0, "keepalive.ServerParameters.Time (0: 2 h)")
	keepaliveTimeout := flag.Duration("keepalive-timeout", 0, "keepalive.ServerParameters.Timeout (0: 20 s)")
	minTime := flag.Duration("min-time", 0, "keepalive.EnforcementPolicy.MinTime (0: 5 min)")
	permitWithoutStream := flag.Bool("permit-without-stream", false, "keepalive.EnforcementPolicy.PermitWithoutStream")
	maxIdle := flag.Duration("max-connection-idle", 0, "keepalive.ServerParameters.MaxConnectionIdle (0: infinite)")
	maxAge := flag.Duration("max-connection-age", 0, "keepalive.ServerParameters.MaxConnectionAge (0: infinite)")
	maxAgeGrace := flag.Duration("max-connection-age-grace", 0, "keepalive.ServerParameters.MaxConnectionAgeGrace (0: infinite)")
	keepIdle := flag.Duration("listener-keepalive", 0, "the TCP keepalive idle of each accepted connection (0: 15 s, negative: off)")
	keepInterval := flag.Duration("listener-keepalive-interval", 0, "the TCP keepalive interval (0: 15 s)")
	keepCount := flag.Int("listener-keepalive-count", 0, "the TCP keepalive count (0: 9)")
	flag.Parse()

	// at the defaults this is net.Listen: Go turns the keepalive on with its own defaults (15 s, 15 s, 9)
	config := net.ListenConfig{KeepAlive: *keepIdle}
	if *keepIdle > 0 || *keepInterval > 0 || *keepCount > 0 {
		config.KeepAliveConfig = net.KeepAliveConfig{Enable: true, Idle: *keepIdle, Interval: *keepInterval, Count: *keepCount}
	}
	inner, err := config.Listen(context.Background(), "tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		emit("fail", map[string]any{"why": err.Error()})
		os.Exit(1)
	}
	server := grpc.NewServer(
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time:                  *keepaliveTime,
			Timeout:               *keepaliveTimeout,
			MaxConnectionIdle:     *maxIdle,
			MaxConnectionAge:      *maxAge,
			MaxConnectionAgeGrace: *maxAgeGrace,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: *minTime, PermitWithoutStream: *permitWithoutStream}),
	)
	healthpb.RegisterHealthServer(server, health{})

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		emit("stopping", nil)
		server.GracefulStop()
	}()

	emit("listening", map[string]any{
		"port": *port, "grpc": grpc.Version,
		"keepalive_time": keepaliveTime.String(), "keepalive_timeout": keepaliveTimeout.String(), "min_time": minTime.String(),
		"permit_without_stream": *permitWithoutStream, "listener_keepalive": keepIdle.String(),
		"listener_keepalive_interval": keepInterval.String(), "listener_keepalive_count": *keepCount,
	})
	if err := server.Serve(listener{inner}); err != nil {
		emit("fail", map[string]any{"why": err.Error()})
		os.Exit(1)
	}
}
