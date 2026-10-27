/* prober.h - the record the kernel side writes and user space prints */
#ifndef HARNESS_PROBER_H
#define HARNESS_PROBER_H

enum {
	EV_STATE = 1, /* a TCP state change */
	EV_ACCEPT,    /* a connection accepted, with its owner's fd */
	EV_RETRANS,   /* a segment retransmitted: the tail loss probe, the RTO timer's, or a fast one */
	EV_RST_TX,    /* a reset sent from a socket (no skb: an active reset) */
	EV_RST_RX,    /* a reset received */
	EV_ERROR,     /* an error reported to the socket's owner: sk_err */
	EV_DESTROY,   /* the socket destroyed */
	EV_TW_ENTER,  /* into TIME_WAIT */
	EV_TW_KILL,   /* a TIME_WAIT socket removed */
	EV_REQ_NEW,   /* a request sock born (a SYN accepted onto a listener) */
	EV_RST_V4,    /* a reset sent by tcp_v4_send_reset, with or without a socket */
	EV_PROBE,     /* a probe sent by tcp_write_wakeup: keepalive or zero window */
	EV_RX,        /* a segment received on an established socket (tcp_probe) */
	EV_TIMER,     /* a timer of a socket that the wheel started: its keepalive, or its retransmit timer */
	EV_TX,        /* bytes the owner gave the socket to send (tcp_sendmsg): a proxy's departure */
};

/* what EV_PROBE's extra says the probe was */
enum { PROBE_OTHER = 0, PROBE_KEEPALIVE = 1, PROBE_WINDOW = 2 };

/* which timer EV_TIMER's extra says started, in its low byte, and TIMER_OWNED when the owner of
 * the socket held the socket at that time. The keepalive timer then tries again HZ/20 later,
 * and it sends nothing. */
enum { TIMER_KEEPALIVE = 1, TIMER_RETRANSMIT = 2, TIMER_OWNED = 0x100 };

/* the connection's TCP state when the record was taken */
struct tcp_now {
	__u32 retransmits; /* icsk_retransmits: the RTO timer's retransmissions this episode */
	__u32 pending;     /* icsk_pending: which retransmit-timer event is armed */
	__u32 backoff;     /* icsk_backoff */
	__u32 probes_out;  /* icsk_probes_out */
	__u32 rto;         /* icsk_rto, in jiffies */
	__u32 srtt_us;     /* the smoothed RTT, in microseconds */
	__u32 snd_una, snd_nxt, rcv_nxt;
	/* the scoreboard and the reordering state: what SACK, DSACK and out-of-order arrivals did */
	__u32 sacked_out;  /* the segments the peer SACKed */
	__u32 lost_out;    /* the segments marked lost */
	__u32 reordering;  /* the reordering degree the kernel holds, in segments: tcp_reordering at first */
	__u32 reord_seen;  /* the reorderings the kernel detected */
	__u32 dsack_dups;  /* the DSACK blocks received: segments the peer got twice */
	__u32 rcv_ooopack; /* the segments that arrived out of order */
};

/* the segment a record is about: retransmitted, or received. For EV_TX, it is the write: its
 * first sequence number (write_seq) and its length */
struct seg {
	__u32 seq, ack, len, flags;
};

struct ev {
	__u64 mono, tai, cookie, nscookie, cgid, skaddr, ino;
	__u32 kind, netns, saddr, daddr, extra;
	__s32 pid, fd, oldst, newst, state, err, owner;
	__u16 sport, dport;
	__u32 has_tcp, has_seg;
	struct tcp_now tcp;
	struct seg seg;
	/* EV_TIMER: how many jiffies behind its wheel slot the CPU started the timer, which no timer's
	 * rounding explains (a stalled vCPU does), and how many after its own expiry */
	__u32 behind, late;
	char comm[16];
};

#endif
