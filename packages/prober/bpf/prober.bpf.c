// SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause)
/* prober.bpf.c - the prober's kernel source: a libbpf CO-RE program that records
 * what the kernel does to every TCP socket in the network namespaces it watches, each record
 * stamped on CLOCK_MONOTONIC, which every container on the VM shares.
 *
 * Its core was built and verified first: the state changes, the owner at
 * connect and accept, retransmissions, resets, error reports, destruction, TIME_WAIT and request
 * socks, with the socket cookie, the namespace and the cgroup. The harness adds five things:
 * - each probe tcp_write_wakeup sends, as keepalive or zero-window;
 * - every segment received on an established socket, so a frozen peer's ACKs show;
 * - the connection's retransmit-timer state on each retransmission, so the tail loss probe (its
 *   pending event is the loss probe) parts from the RTO timer's retransmissions, which alone
 *   count toward tcp_retries2; with it the SACK scoreboard and the reordering state;
 * - each run of a socket's keepalive or retransmit timer, with how far behind its wheel slot it
 *   ran, so a run that a stalled vCPU delayed tells itself apart from the kernel's own timing;
 * - each write of the owner, so a proxy's own time shows between its two sockets. */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include "prober.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct { __uint(type, BPF_MAP_TYPE_RINGBUF); __uint(max_entries, 1 << 24); } rb SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 256); __type(key, __u32); __type(value, __u8); } want SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 65536); __type(key, __u32); __type(value, __s32); } cfd SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY); __uint(max_entries, 1); __type(key, __u32); __type(value, __u64); } lost SEC(".maps");

/* the pid-namespace level Docker Desktop's containers sit at, as measured */
const volatile __u32 pidns_level = 3;
const volatile __u8 all_ns = 0;

static __always_inline bool ok_ns(__u32 ns) { return all_ns || bpf_map_lookup_elem(&want, &ns); }

/* Wake the reader only when 256 KiB are waiting: a wakeup per record cost about 3 us per event
 * (as measured). The reader also drains the ring every 20 ms. */
static __always_inline long wake(void)
{
	return bpf_ringbuf_query(&rb, BPF_RB_AVAIL_DATA) >= (1 << 18) ? BPF_RB_FORCE_WAKEUP : BPF_RB_NO_WAKEUP;
}

static __always_inline __s32 docker_pid(void)
{
	struct task_struct *t = (struct task_struct *)bpf_get_current_task();
	struct pid *p = BPF_CORE_READ(t, group_leader, thread_pid);
	unsigned int lvl = BPF_CORE_READ(p, level);
	struct upid up = {};
	if (lvl < pidns_level)
		return -1;
	bpf_probe_read_kernel(&up, sizeof(up), &p->numbers[pidns_level]);
	return up.nr;
}

static __always_inline struct ev *reserve(void)
{
	struct ev *e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
	if (!e) {
		__u32 k = 0; __u64 *n = bpf_map_lookup_elem(&lost, &k);
		if (n) (*n)++;
		return 0;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->mono = bpf_ktime_get_ns();
	e->pid = docker_pid();
	bpf_get_current_comm(e->comm, sizeof(e->comm));
	return e;
}

static __always_inline void fill_sk(struct ev *e, const struct sock *sk)
{
	e->netns = BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum);
	e->nscookie = BPF_CORE_READ(sk, __sk_common.skc_net.net, net_cookie);
	e->cgid = BPF_CORE_READ(sk, sk_cgrp_data.cgroup, kn, id);
	e->saddr = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
	e->daddr = BPF_CORE_READ(sk, __sk_common.skc_daddr);
	e->sport = BPF_CORE_READ(sk, __sk_common.skc_num);
	e->dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
	e->state = BPF_CORE_READ(sk, __sk_common.skc_state);
	e->err = BPF_CORE_READ(sk, sk_err);
}

/* the retransmit timer's state and the sequence space, as the kernel holds them now */
static __always_inline void fill_tcp(struct ev *e, const struct sock *sk)
{
	const struct inet_connection_sock *icsk = (const struct inet_connection_sock *)sk;
	const struct tcp_sock *tp = (const struct tcp_sock *)sk;
	e->has_tcp = 1;
	e->tcp.retransmits = BPF_CORE_READ(icsk, icsk_retransmits);
	e->tcp.pending = BPF_CORE_READ(icsk, icsk_pending);
	e->tcp.backoff = BPF_CORE_READ(icsk, icsk_backoff);
	e->tcp.probes_out = BPF_CORE_READ(icsk, icsk_probes_out);
	e->tcp.rto = BPF_CORE_READ(icsk, icsk_rto);
	e->tcp.srtt_us = BPF_CORE_READ(tp, srtt_us) >> 3;
	e->tcp.snd_una = BPF_CORE_READ(tp, snd_una);
	e->tcp.snd_nxt = BPF_CORE_READ(tp, snd_nxt);
	e->tcp.rcv_nxt = BPF_CORE_READ(tp, rcv_nxt);
	e->tcp.sacked_out = BPF_CORE_READ(tp, sacked_out);
	e->tcp.lost_out = BPF_CORE_READ(tp, lost_out);
	e->tcp.reordering = BPF_CORE_READ(tp, reordering);
	e->tcp.reord_seen = BPF_CORE_READ(tp, reord_seen);
	e->tcp.dsack_dups = BPF_CORE_READ(tp, dsack_dups);
	e->tcp.rcv_ooopack = BPF_CORE_READ(tp, rcv_ooopack);
}

SEC("tp_btf/inet_sock_set_state")
int BPF_PROG(on_state, const struct sock *sk, const int oldstate, const int newstate)
{
	if (sk->sk_protocol != IPPROTO_TCP || !ok_ns(sk->__sk_common.skc_net.net->ns.inum))
		return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_STATE; e->tai = bpf_ktime_get_tai_ns();
	e->cookie = bpf_get_socket_cookie((void *)sk);
	e->skaddr = (__u64)sk;
	fill_sk(e, sk);
	e->oldst = oldstate; e->newst = newstate;
	if (oldstate == 7 && newstate == 2) {             /* connect(): the owner and its fd */
		__u32 tid = (__u32)bpf_get_current_pid_tgid();
		__s32 *fd = bpf_map_lookup_elem(&cfd, &tid);
		e->fd = fd ? *fd : -1; e->owner = 1;
	}
	bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("tracepoint/syscalls/sys_enter_connect")
int on_connect_enter(struct trace_event_raw_sys_enter *ctx)
{
	__u32 tid = (__u32)bpf_get_current_pid_tgid(); __s32 fd = (__s32)ctx->args[0];
	bpf_map_update_elem(&cfd, &tid, &fd, BPF_ANY);
	return 0;
}

SEC("tracepoint/syscalls/sys_exit_connect")
int on_connect_exit(struct trace_event_raw_sys_exit *ctx)
{
	__u32 tid = (__u32)bpf_get_current_pid_tgid();
	bpf_map_delete_elem(&cfd, &tid);
	return 0;
}

static __always_inline int accept_exit(long ret)
{
	if (ret < 0) return 0;
	struct task_struct *t = (struct task_struct *)bpf_get_current_task();
	struct file **fdt = BPF_CORE_READ(t, files, fdt, fd);
	struct file *f = 0;
	bpf_probe_read_kernel(&f, sizeof(f), &fdt[ret]);
	struct socket *so = BPF_CORE_READ(f, private_data);
	struct sock *sk = BPF_CORE_READ(so, sk);
	__u32 ns = BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum);
	if (!ok_ns(ns) || BPF_CORE_READ(sk, sk_protocol) != IPPROTO_TCP) return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_ACCEPT;
	e->cookie = BPF_CORE_READ(sk, __sk_common.skc_cookie.counter);
	fill_sk(e, sk);
	e->fd = (__s32)ret; e->owner = 1;
	e->ino = BPF_CORE_READ(f, f_inode, i_ino);
	bpf_ringbuf_submit(e, wake());
	return 0;
}
SEC("tracepoint/syscalls/sys_exit_accept4")
int on_accept4_exit(struct trace_event_raw_sys_exit *ctx) { return accept_exit(ctx->ret); }
SEC("tracepoint/syscalls/sys_exit_accept")
int on_accept_exit(struct trace_event_raw_sys_exit *ctx) { return accept_exit(ctx->ret); }

static __always_inline struct ev *sk_record(const struct sock *sk, __u32 kind, __u32 extra)
{
	/* a reset to a packet with no socket has no sk: newer kernels mark the argument nullable,
	 * and their verifier refuses arithmetic on it before this check (6.17's does) */
	if (!sk) return 0;
	if (!ok_ns(BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum)))
		return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = kind;
	e->cookie = bpf_get_socket_cookie((void *)sk);
	fill_sk(e, sk);
	e->extra = extra;
	return e;
}

static __always_inline int sk_event(const struct sock *sk, __u32 kind, __u32 extra)
{
	struct ev *e = sk_record(sk, kind, extra);
	if (e) bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("tp_btf/tcp_retransmit_skb")
int BPF_PROG(on_retrans, const struct sock *sk, const struct sk_buff *skb)
{
	struct ev *e = sk_record(sk, EV_RETRANS, 0);
	if (!e) return 0;
	fill_tcp(e, sk);
	e->has_seg = 1;
	bpf_probe_read_kernel(&e->seg.seq, sizeof(e->seg.seq), skb->cb);    /* TCP_SKB_CB(skb)->seq */
	e->seg.len = BPF_CORE_READ(skb, len);
	bpf_ringbuf_submit(e, wake());
	return 0;
}

/* keepalive's probes and the zero-window ones both go out through tcp_write_wakeup. The SNMP
 * counters are an anonymous enum, which CO-RE cannot relocate by name; the image's build takes
 * vmlinux.h from the kernel it runs on, so these constants are that kernel's own. */
SEC("fentry/tcp_write_wakeup")
int BPF_PROG(on_probe, struct sock *sk, int mib)
{
	__u32 what = PROBE_OTHER;
	if (mib == LINUX_MIB_TCPKEEPALIVE) what = PROBE_KEEPALIVE;
	else if (mib == LINUX_MIB_TCPWINPROBE) what = PROBE_WINDOW;
	struct ev *e = sk_record(sk, EV_PROBE, what);
	if (!e) return 0;
	fill_tcp(e, sk);
	bpf_ringbuf_submit(e, wake());
	return 0;
}

/* The timer each CPU's wheel is running now, and the wheel slot it is running it from.
 * call_timer_fn traces timer_expire_entry and then calls the timer's own function, on the same
 * CPU, so a socket's timer function finds its own wheel slot here. */
struct expiring { __u64 timer, baseclk, now; };
struct { __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY); __uint(max_entries, 1); __type(key, __u32); __type(value, struct expiring); } expiring SEC(".maps");

SEC("tp_btf/timer_expire_entry")
int BPF_PROG(on_timer_expire, struct timer_list *timer, unsigned long baseclk)
{
	__u32 k = 0;
	struct expiring *x = bpf_map_lookup_elem(&expiring, &k);
	if (x) { x->timer = (__u64)timer; x->baseclk = baseclk; x->now = bpf_jiffies64(); }
	return 0;
}

/* A socket's own timer, run from the wheel. `behind` is how many jiffies after its slot the CPU
 * ran it: the wheel runs a slot in the tick it falls due, so any lag is the CPU's or the VM's, a
 * vCPU the host descheduled, which no timer's rounding explains. `late` is how many after the
 * expiry its owner asked for, the rounding included. Whether the socket's owner held it says
 * whether the keepalive timer will put itself off by HZ/20. The socket is the timer's container,
 * read through CO-RE like any probe read, its cookie as accept's is. */
static __always_inline int timer_fired(__u64 skaddr, const struct timer_list *t, __u32 what)
{
	__u32 k = 0;
	struct expiring *x = bpf_map_lookup_elem(&expiring, &k);
	if (!x || x->timer != (__u64)t) return 0;
	const struct sock *sk = (const struct sock *)skaddr;
	if (!ok_ns(BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum))) return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_TIMER;
	e->cookie = BPF_CORE_READ(sk, __sk_common.skc_cookie.counter);
	fill_sk(e, sk);
	fill_tcp(e, sk);
	/* a socket its owner holds as the timer runs: keepalive tries again HZ/20 later */
	e->extra = what | (BPF_CORE_READ(sk, sk_lock.owned) ? TIMER_OWNED : 0);
	__u64 expires = BPF_CORE_READ(t, expires);
	e->behind = (__u32)(x->now - x->baseclk);
	e->late = x->now > expires ? (__u32)(x->now - expires) : 0;
	bpf_ringbuf_submit(e, wake());
	return 0;
}

/* Linux 7.0 moved the two timers of TCP (tcp_timer.c, inet_csk_init_xmit_timers). Before it, the
 * retransmit timer is icsk_retransmit_timer of the connection socket, and the keepalive timer is
 * sk_timer of the socket. From it, the retransmit timer is tcp_retransmit_timer of the socket (a
 * union with sk_timer), and the keepalive timer is icsk_keepalive_timer of the connection socket.
 * These flavors name each field, thus the program compiles against the types of either kernel. On
 * a kernel without a field, the verifier drops the branch that reads it. */
struct inet_connection_sock___pre7 { struct timer_list icsk_retransmit_timer; } __attribute__((preserve_access_index));
struct sock___v7 { struct timer_list tcp_retransmit_timer; } __attribute__((preserve_access_index));
struct inet_connection_sock___v7 { struct timer_list icsk_keepalive_timer; } __attribute__((preserve_access_index));

SEC("fentry/tcp_keepalive_timer")
int BPF_PROG(on_keepalive_timer, struct timer_list *t)
{
	if (bpf_core_field_exists(struct inet_connection_sock___v7, icsk_keepalive_timer))
		return timer_fired((__u64)t - bpf_core_field_offset(struct inet_connection_sock___v7, icsk_keepalive_timer), t, TIMER_KEEPALIVE);
	return timer_fired((__u64)t - bpf_core_field_offset(struct sock, sk_timer), t, TIMER_KEEPALIVE);
}

/* the retransmit timer: the RTO's, the tail loss probe's and the zero-window probe's */
SEC("fentry/tcp_write_timer")
int BPF_PROG(on_write_timer, struct timer_list *t)
{
	if (bpf_core_field_exists(struct sock___v7, tcp_retransmit_timer))
		return timer_fired((__u64)t - bpf_core_field_offset(struct sock___v7, tcp_retransmit_timer), t, TIMER_RETRANSMIT);
	return timer_fired((__u64)t - bpf_core_field_offset(struct inet_connection_sock___pre7, icsk_retransmit_timer),
			   t, TIMER_RETRANSMIT);
}

/* every segment that reaches an established socket: tcp_rcv_established's first act */
SEC("tp_btf/tcp_probe")
int BPF_PROG(on_rx, struct sock *sk, struct sk_buff *skb)
{
	struct ev *e = sk_record(sk, EV_RX, 0);
	if (!e) return 0;
	fill_tcp(e, sk);
	struct tcphdr th = {};
	bpf_probe_read_kernel(&th, sizeof(th), BPF_CORE_READ(skb, data));
	__u32 len = BPF_CORE_READ(skb, len);
	__u32 head = (__u32)th.doff * 4;
	e->has_seg = 1;
	e->seg.seq = bpf_ntohl(th.seq);
	e->seg.ack = bpf_ntohl(th.ack_seq);
	e->seg.len = len > head ? len - head : 0;
	e->seg.flags = ((__u32)th.fin) | ((__u32)th.syn << 1) | ((__u32)th.rst << 2) | ((__u32)th.psh << 3) |
		       ((__u32)th.ack << 4);
	bpf_ringbuf_submit(e, wake());
	return 0;
}

/* every write the owner makes: the bytes enter the socket here, and with TCP_NODELAY leave it in
 * the same call. A proxy's time is from its arrival on one socket to this on the other. */
SEC("fentry/tcp_sendmsg")
int BPF_PROG(on_tx, struct sock *sk, struct msghdr *msg, size_t size)
{
	struct ev *e = sk_record(sk, EV_TX, 0);
	if (!e) return 0;
	fill_tcp(e, sk);
	e->has_seg = 1;
	e->seg.seq = BPF_CORE_READ((struct tcp_sock *)sk, write_seq);
	e->seg.len = (__u32)size;
	bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("tp_btf/tcp_send_reset")
int BPF_PROG(on_rst_tx, const struct sock *sk, const struct sk_buff *skb) { return sk_event(sk, EV_RST_TX, skb == 0); }

SEC("tp_btf/tcp_receive_reset")
int BPF_PROG(on_rst_rx, struct sock *sk) { return sk_event(sk, EV_RST_RX, 0); }

/* tcp_write_err is inlined on the measured kernel, so the error report stands for it */
SEC("tp_btf/inet_sk_error_report")
int BPF_PROG(on_error, const struct sock *sk)
{
	if (sk->sk_protocol != IPPROTO_TCP) return 0;
	struct ev *e = sk_record(sk, EV_ERROR, BPF_CORE_READ((struct inet_connection_sock *)sk, icsk_pending));
	if (!e) return 0;
	fill_tcp(e, sk);
	bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("tp_btf/tcp_destroy_sock")
int BPF_PROG(on_destroy, struct sock *sk) { return sk_event(sk, EV_DESTROY, 0); }

SEC("fentry/tcp_time_wait")
int BPF_PROG(on_tw_enter, struct sock *sk, int state, int timeo) { return sk_event(sk, EV_TW_ENTER, state); }

SEC("fentry/inet_csk_reqsk_queue_hash_add")
int BPF_PROG(on_req_new, struct sock *sk, struct request_sock *req, unsigned long timeout)
{
	if (!ok_ns(BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum)))
		return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_REQ_NEW;
	e->cookie = bpf_get_socket_cookie((void *)req);       /* the child inherits this cookie */
	e->extra = (__u32)bpf_get_socket_cookie((void *)sk);   /* the listener (low 32 bits) */
	e->netns = BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum);
	e->saddr = BPF_CORE_READ(req, __req_common.skc_rcv_saddr);
	e->daddr = BPF_CORE_READ(req, __req_common.skc_daddr);
	e->sport = BPF_CORE_READ(req, __req_common.skc_num);
	e->dport = bpf_ntohs(BPF_CORE_READ(req, __req_common.skc_dport));
	bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("fentry/inet_twsk_kill")
int BPF_PROG(on_tw_kill, struct inet_timewait_sock *tw)
{
	__u32 ns = BPF_CORE_READ(tw, __tw_common.skc_net.net, ns.inum);
	if (!ok_ns(ns)) return 0;
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_TW_KILL; e->netns = ns;
	e->cookie = BPF_CORE_READ(tw, __tw_common.skc_cookie.counter);
	e->saddr = BPF_CORE_READ(tw, __tw_common.skc_rcv_saddr);
	e->daddr = BPF_CORE_READ(tw, __tw_common.skc_daddr);
	e->sport = BPF_CORE_READ(tw, __tw_common.skc_num);
	e->dport = bpf_ntohs(BPF_CORE_READ(tw, __tw_common.skc_dport));
	e->extra = BPF_CORE_READ(tw, tw_substate);
	bpf_ringbuf_submit(e, wake());
	return 0;
}

SEC("fentry/tcp_v4_send_reset")
int BPF_PROG(on_rst_v4, const struct sock *sk, struct sk_buff *skb)
{
	unsigned char *head = BPF_CORE_READ(skb, head);
	__u16 nh = BPF_CORE_READ(skb, network_header), th = BPF_CORE_READ(skb, transport_header);
	/* the socket's netns when there is one (skb->dev is NULL for an RST answered by a listener) */
	__u32 ns = sk ? BPF_CORE_READ(sk, __sk_common.skc_net.net, ns.inum) : BPF_CORE_READ(skb, dev, nd_net.net, ns.inum);
	if (!ok_ns(ns)) return 0;
	struct iphdr ip = {}; struct tcphdr tcp = {};
	bpf_probe_read_kernel(&ip, sizeof(ip), head + nh);
	bpf_probe_read_kernel(&tcp, sizeof(tcp), head + th);
	struct ev *e = reserve();
	if (!e) return 0;
	e->kind = EV_RST_V4; e->netns = ns;
	e->state = sk ? BPF_CORE_READ(sk, __sk_common.skc_state) : 0;
	e->cookie = sk ? BPF_CORE_READ(sk, __sk_common.skc_cookie.counter) : 0;
	e->saddr = ip.daddr; e->daddr = ip.saddr;          /* the RST goes back to the sender */
	e->sport = bpf_ntohs(tcp.dest); e->dport = bpf_ntohs(tcp.source);
	e->extra = ((__u32)tcp.syn) | ((__u32)tcp.ack << 1) | ((__u32)tcp.fin << 2) | ((__u32)tcp.rst << 3);
	bpf_ringbuf_submit(e, wake());
	return 0;
}
