/* prober-c [--object PATH] NETNS... | prober-c --decode FILE
 *
 * The collector for the prober's kernel source, in C on libbpf. It does what the Rust collector
 * does, line for line: loads prober.bpf.o, watches the network namespaces given by inode, prints
 * each record as one JSON line, and every second the clock track and how many records the ring
 * buffer dropped. Its lines are the Rust collector's byte for byte: serde_json's sorted keys, its
 * escapes, Rust's lossy UTF-8. With --decode it reads raw records from a file instead.
 */
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <errno.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>

#define SIZE 216 /* struct ev: seven u64, five u32, seven i32, two u16, two u32, fifteen u32, four u32, two u32, 16 bytes */
#define ICSK_TIME_LOSS_PROBE 5
#define TIMER_OWNED 0x100 /* prober.h: a timer found its socket held by its owner */
#define DEFAULT_OBJECT "/opt/harness/prober.bpf.o"
#define TRACEFS "/sys/kernel/tracing"

static const char *const KINDS[] = {
	"state", "accept", "retrans", "rst_tx", "rst_rx", "error", "destroy",
	"tw_enter", "tw_kill", "req_new", "rst_v4", "probe", "rx", "timer", "tx",
};

struct ev {
	uint64_t mono, tai, cookie, nscookie, cgid, skaddr, ino;
	uint32_t kind, netns;
	uint8_t saddr[4], daddr[4];
	uint32_t extra;
	int32_t pid, fd, oldst, newst, state, err, owner;
	uint16_t sport, dport;
	uint32_t has_tcp, has_seg;
	/* retransmits, pending, backoff, probes_out, rto, srtt_us, snd_una, snd_nxt, rcv_nxt, then
	 * sacked_out, lost_out, reordering, reord_seen, dsack_dups, rcv_ooopack */
	uint32_t tcp[15];
	uint32_t seg[4]; /* seq, ack, len, flags */
	uint32_t behind, late; /* a timer's jiffies behind its wheel slot, and after its expiry */
	uint8_t comm[16];
	size_t comm_len;
};

static uint64_t clock_ns(clockid_t clock)
{
	struct timespec ts;
	clock_gettime(clock, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

/* Reads the record field by field, native-endian, as the kernel side laid it out. */
static bool decode(const uint8_t *b, size_t len, struct ev *e)
{
	if (len != SIZE)
		return false;
	size_t at = 0;
#define TAKE(dst) (memcpy(&(dst), b + at, sizeof(dst)), at += sizeof(dst))
	TAKE(e->mono); TAKE(e->tai); TAKE(e->cookie); TAKE(e->nscookie);
	TAKE(e->cgid); TAKE(e->skaddr); TAKE(e->ino);
	TAKE(e->kind); TAKE(e->netns); TAKE(e->saddr); TAKE(e->daddr); TAKE(e->extra);
	TAKE(e->pid); TAKE(e->fd); TAKE(e->oldst); TAKE(e->newst);
	TAKE(e->state); TAKE(e->err); TAKE(e->owner);
	TAKE(e->sport); TAKE(e->dport); TAKE(e->has_tcp); TAKE(e->has_seg);
	TAKE(e->tcp); TAKE(e->seg); TAKE(e->behind); TAKE(e->late); TAKE(e->comm);
#undef TAKE
	e->comm_len = 0;
	while (e->comm_len < sizeof(e->comm) && e->comm[e->comm_len] != 0)
		e->comm_len++;
	return true;
}

static const char *kind_name(const struct ev *e)
{
	return e->kind >= 1 && e->kind <= sizeof(KINDS) / sizeof(KINDS[0]) ? KINDS[e->kind - 1] : "unknown";
}

/* A line under construction, written with one fwrite. No record's line comes near 2 KiB: with
 * every integer at its extreme it is under 900 bytes, and its longest field is a 16-byte name, at
 * most six bytes a byte once escaped. */
struct buf {
	char b[2048];
	size_t n;
};

static inline void put(struct buf *o, const char *s, size_t n)
{
	memcpy(o->b + o->n, s, n);
	o->n += n;
}
#define PUT(o, literal) put(o, literal, sizeof(literal) - 1)

static inline void put_u64(struct buf *o, uint64_t v)
{
	char digits[20];
	int at = 20;
	do {
		digits[--at] = (char)('0' + v % 10);
		v /= 10;
	} while (v);
	put(o, digits + at, (size_t)(20 - at));
}

static inline void put_i64(struct buf *o, int64_t v)
{
	if (v < 0) {
		o->b[o->n++] = '-';
		put_u64(o, (uint64_t)(-(v + 1)) + 1);
	} else {
		put_u64(o, (uint64_t)v);
	}
}

/* One byte of a JSON string as serde_json writes it: \" \\ \b \f \n \r \t, other control
 * characters as \u00xx in lowercase hex, everything else as it is. */
static inline void put_escaped(struct buf *o, uint8_t c)
{
	static const char hex[] = "0123456789abcdef";
	switch (c) {
	case '"': PUT(o, "\\\""); return;
	case '\\': PUT(o, "\\\\"); return;
	case '\b': PUT(o, "\\b"); return;
	case '\f': PUT(o, "\\f"); return;
	case '\n': PUT(o, "\\n"); return;
	case '\r': PUT(o, "\\r"); return;
	case '\t': PUT(o, "\\t"); return;
	}
	if (c < 0x20) {
		PUT(o, "\\u00");
		o->b[o->n++] = hex[c >> 4];
		o->b[o->n++] = hex[c & 0xf];
	} else {
		o->b[o->n++] = (char)c;
	}
}

/* Raw bytes as a JSON string, decoded as Rust's String::from_utf8_lossy decodes them: each
 * maximal prefix of a would-be UTF-8 sequence that cannot complete becomes one U+FFFD, and
 * decoding resumes at the byte that broke it. */
static void put_lossy_quoted(struct buf *o, const uint8_t *b, size_t n)
{
	o->b[o->n++] = '"';
	for (size_t i = 0; i < n;) {
		uint8_t c = b[i];
		if (c < 0x80) {
			put_escaped(o, c);
			i++;
			continue;
		}
		int need = 0;
		uint8_t lo = 0x80, hi = 0xbf;
		if (c >= 0xc2 && c <= 0xdf) need = 1;
		else if (c == 0xe0) need = 2, lo = 0xa0;
		else if (c == 0xed) need = 2, hi = 0x9f;
		else if (c >= 0xe1 && c <= 0xef) need = 2;
		else if (c == 0xf0) need = 3, lo = 0x90;
		else if (c == 0xf4) need = 3, hi = 0x8f;
		else if (c >= 0xf1 && c <= 0xf3) need = 3;
		else {
			PUT(o, "\xef\xbf\xbd");
			i++;
			continue;
		}
		size_t j = i + 1;
		bool ok = true;
		for (int k = 0; k < need; k++) {
			uint8_t first = k == 0 ? lo : 0x80, last = k == 0 ? hi : 0xbf;
			if (j >= n || b[j] < first || b[j] > last) {
				ok = false;
				break;
			}
			j++;
		}
		if (ok)
			put(o, (const char *)b + i, j - i);
		else
			PUT(o, "\xef\xbf\xbd");
		i = j;
	}
	o->b[o->n++] = '"';
}

/* `{"unit":"…","value":N.0}`: every amount a record carries is a whole u32, written as a float */
#define PUT_QUANTITY(o, value, unit)                    \
	do {                                            \
		PUT(o, "{\"unit\":\"" unit "\",\"value\":"); \
		put_u64(o, (value));                    \
		PUT(o, ".0}");                          \
	} while (0)

/* `"a.b.c.d:port"` */
static void put_endpoint(struct buf *o, const uint8_t a[4], uint16_t port)
{
	o->b[o->n++] = '"';
	for (int k = 0; k < 4; k++) {
		if (k)
			o->b[o->n++] = '.';
		put_u64(o, a[k]);
	}
	o->b[o->n++] = ':';
	put_u64(o, port);
	o->b[o->n++] = '"';
}

/* The record's line, its keys in byte order as serde_json writes them, built in a buffer and
 * written once. */
static void line(FILE *out, const struct ev *e)
{
	struct buf o = {.n = 0};
	const char *name = kind_name(e);
	uint32_t kind = e->kind;
	o.b[o.n++] = '{';
	if (kind == 4) {
		if (e->extra == 1)
			PUT(&o, "\"active\":true,");
		else
			PUT(&o, "\"active\":false,");
	}
	if (kind == 14) {
		PUT(&o, "\"behind\":");
		PUT_QUANTITY(&o, e->behind, "jiffy");
		o.b[o.n++] = ',';
	}
	PUT(&o, "\"cg\":");
	put_u64(&o, e->cgid);
	PUT(&o, ",\"comm\":");
	put_lossy_quoted(&o, e->comm, e->comm_len);
	PUT(&o, ",\"cookie\":");
	put_u64(&o, e->cookie);
	PUT(&o, ",\"dst\":");
	put_endpoint(&o, e->daddr, e->dport);
	PUT(&o, ",\"err\":");
	put_i64(&o, e->err);
	PUT(&o, ",\"ev\":\"");
	put(&o, name, strlen(name));
	o.b[o.n++] = '"';
	if (e->owner != 0) {
		PUT(&o, ",\"fd\":");
		put_i64(&o, e->fd);
	}
	if (kind == 14) {
		PUT(&o, ",\"late\":");
		PUT_QUANTITY(&o, e->late, "jiffy");
	}
	PUT(&o, ",\"mono\":");
	put_u64(&o, e->mono);
	PUT(&o, ",\"netns\":");
	put_u64(&o, e->netns);
	if (kind == 1) {
		PUT(&o, ",\"new\":");
		put_i64(&o, e->newst);
		PUT(&o, ",\"old\":");
		put_i64(&o, e->oldst);
	}
	if (kind == 14) {
		if (e->extra & TIMER_OWNED)
			PUT(&o, ",\"owned\":true");
		else
			PUT(&o, ",\"owned\":false");
	}
	PUT(&o, ",\"pid\":");
	put_i64(&o, e->pid);
	if (e->has_seg) {
		PUT(&o, ",\"seg\":{");
		if (kind == 13) {
			PUT(&o, "\"ack\":");
			put_u64(&o, e->seg[1]);
			PUT(&o, ",\"flags\":");
			put_u64(&o, e->seg[3]);
			o.b[o.n++] = ',';
		}
		PUT(&o, "\"len\":");
		PUT_QUANTITY(&o, e->seg[2], "B");
		PUT(&o, ",\"seq\":");
		put_u64(&o, e->seg[0]);
		o.b[o.n++] = '}';
	}
	PUT(&o, ",\"src\":");
	put_endpoint(&o, e->saddr, e->sport);
	PUT(&o, ",\"state\":");
	put_i64(&o, e->state);
	if (e->tai != 0) {
		PUT(&o, ",\"tai\":");
		put_u64(&o, e->tai);
	}
	if (e->has_tcp) {
		const uint32_t *t = e->tcp;
		PUT(&o, ",\"tcp\":{\"backoff\":");
		put_u64(&o, t[2]);
		PUT(&o, ",\"dsack_dups\":");
		put_u64(&o, t[13]);
		PUT(&o, ",\"lost\":");
		put_u64(&o, t[10]);
		PUT(&o, ",\"pending\":");
		put_u64(&o, t[1]);
		PUT(&o, ",\"probes_out\":");
		put_u64(&o, t[3]);
		PUT(&o, ",\"rcv_nxt\":");
		put_u64(&o, t[8]);
		PUT(&o, ",\"rcv_ooopack\":");
		put_u64(&o, t[14]);
		PUT(&o, ",\"reord_seen\":");
		put_u64(&o, t[12]);
		PUT(&o, ",\"reordering\":");
		put_u64(&o, t[11]);
		PUT(&o, ",\"retransmits\":");
		put_u64(&o, t[0]);
		PUT(&o, ",\"rto\":");
		PUT_QUANTITY(&o, t[4], "jiffy");
		PUT(&o, ",\"sacked\":");
		put_u64(&o, t[9]);
		PUT(&o, ",\"snd_nxt\":");
		put_u64(&o, t[7]);
		PUT(&o, ",\"snd_una\":");
		put_u64(&o, t[6]);
		PUT(&o, ",\"srtt\":");
		PUT_QUANTITY(&o, t[5], "us");
		o.b[o.n++] = '}';
	}
	if (kind == 12 || kind == 14) {
		/* a timer's kind is its extra's low byte, beside the owned flag */
		uint32_t what = kind == 14 ? e->extra & 0xff : e->extra;
		if (what == 1)
			PUT(&o, ",\"what\":\"keepalive\"");
		else if (what == 2 && kind == 12)
			PUT(&o, ",\"what\":\"window\"");
		else if (what == 2)
			PUT(&o, ",\"what\":\"retransmit\"");
		else
			PUT(&o, ",\"what\":\"other\"");
	}
	if (kind == 3 && e->has_tcp) {
		uint32_t retransmits = e->tcp[0], pending = e->tcp[1];
		if (pending == ICSK_TIME_LOSS_PROBE)
			PUT(&o, ",\"why\":\"tlp\"");
		else if (pending == 0 && retransmits > 0)
			PUT(&o, ",\"why\":\"rto\"");
		else
			PUT(&o, ",\"why\":\"fast\"");
	}
	if (kind == 6 || kind == 8 || kind == 9 || kind == 10 || kind == 11) {
		PUT(&o, ",\"x\":");
		put_u64(&o, e->extra);
	}
	PUT(&o, "}\n");
	fwrite(o.b, 1, o.n, out);
}

/* a JSON string, for the rare lines that are not records: written in pieces, since a failure's
 * words may escape to more than one buffer holds */
static void qs(FILE *out, const char *s)
{
	struct buf o = {.n = 0};
	o.b[o.n++] = '"';
	for (; *s; s++) {
		put_escaped(&o, (uint8_t)*s);
		if (o.n > sizeof(o.b) - 8) {
			fwrite(o.b, 1, o.n, out);
			o.n = 0;
		}
	}
	o.b[o.n++] = '"';
	fwrite(o.b, 1, o.n, out);
}

static void undecodable(FILE *out, size_t len)
{
	char why[64];
	snprintf(why, sizeof(why), "a record is %d bytes, not %zu", SIZE, len);
	fputs("{\"ev\":\"undecodable\",\"why\":", out);
	qs(out, why);
	fputs("}\n", out);
}

static int fail(const char *format, ...)
{
	char why[512];
	va_list args;
	va_start(args, format);
	vsnprintf(why, sizeof(why), format, args);
	va_end(args);
	fprintf(stdout, "{\"ev\":\"fail\",\"mono\":%" PRIu64 ",\"why\":", clock_ns(CLOCK_MONOTONIC));
	qs(stdout, why);
	fputs("}\n", stdout);
	fflush(stdout);
	return 1;
}

static int decode_file(const char *path)
{
	FILE *in = fopen(path, "rb");
	if (!in)
		return fail("%s: %s", path, strerror(errno));
	uint8_t buf[SIZE];
	size_t got;
	while ((got = fread(buf, 1, SIZE, in)) > 0) {
		struct ev e;
		if (decode(buf, got, &e))
			line(stdout, &e);
		else
			undecodable(stdout, got);
	}
	fclose(in);
	fflush(stdout);
	return 0;
}

static uint64_t records;

static int on_record(void *ctx, void *data, size_t len)
{
	(void)ctx;
	struct ev e;
	if (decode(data, len, &e)) {
		records++;
		line(stdout, &e);
	} else {
		undecodable(stdout, len);
	}
	return 0;
}

int main(int argc, char **argv)
{
	static char buffer[1 << 16];
	setvbuf(stdout, buffer, _IOFBF, sizeof(buffer));
	const char *object = DEFAULT_OBJECT;
	uint32_t watched[256];
	size_t nwatched = 0;
	for (int at = 1; at < argc; at++) {
		if (strcmp(argv[at], "--decode") == 0) {
			if (at + 1 >= argc)
				return fail("--decode needs a file");
			return decode_file(argv[at + 1]);
		}
		if (strcmp(argv[at], "--object") == 0) {
			if (at + 1 >= argc)
				return fail("--object needs a path");
			object = argv[++at];
			continue;
		}
		char *end;
		errno = 0;
		unsigned long netns = strtoul(argv[at], &end, 10);
		if (errno || *end || end == argv[at] || netns > UINT32_MAX || nwatched == 256)
			return fail("%s is not a netns inode", argv[at]);
		watched[nwatched++] = (uint32_t)netns;
	}
	if (nwatched == 0)
		return fail("name at least one network namespace to watch, by its inode");

	struct stat st;
	if (stat(TRACEFS "/events", &st) != 0 && mount("tracefs", TRACEFS, "tracefs", 0, NULL) != 0)
		return fail("mount tracefs: %s", strerror(errno));
	struct bpf_object *obj = bpf_object__open_file(object, NULL);
	if (!obj)
		return fail("open %s: %s", object, strerror(errno));
	int err = bpf_object__load(obj);
	if (err)
		return fail("load %s: %s", object, strerror(-err));
	int want = bpf_object__find_map_fd_by_name(obj, "want");
	for (size_t i = 0; i < nwatched; i++) {
		uint8_t one = 1;
		if (bpf_map_update_elem(want, &watched[i], &one, BPF_ANY))
			return fail("watch %" PRIu32 ": %s", watched[i], strerror(errno));
	}
	struct bpf_program *prog;
	int programs = 0;
	bpf_object__for_each_program(prog, obj) {
		if (!bpf_program__attach(prog))
			return fail("attach %s: %s", bpf_program__name(prog), strerror(errno));
		programs++;
	}
	struct ring_buffer *rb =
		ring_buffer__new(bpf_object__find_map_fd_by_name(obj, "rb"), on_record, NULL, NULL);
	if (!rb)
		return fail("ring buffer: %s", strerror(errno));
	int lost = bpf_object__find_map_fd_by_name(obj, "lost");
	int cpus = libbpf_num_possible_cpus();
	uint64_t *per_cpu = calloc(cpus > 0 ? cpus : 1, sizeof(uint64_t));

	printf("{\"ev\":\"begin\",\"mono\":%" PRIu64 ",\"netns\":[", clock_ns(CLOCK_MONOTONIC));
	for (size_t i = 0; i < nwatched; i++)
		printf("%s%" PRIu32, i ? "," : "", watched[i]);
	printf("],\"programs\":%d,\"tai\":%" PRIu64 "}\n", programs, clock_ns(CLOCK_TAI));
	fflush(stdout);

	uint64_t next = clock_ns(CLOCK_MONOTONIC) + 1000000000ull;
	for (;;) {
		/* woken only when enough is waiting, so drain on every 20 ms tick as well */
		err = ring_buffer__poll(rb, 20);
		if (err < 0 && err != -EINTR)
			return fail("poll: %s", strerror(-err));
		ring_buffer__consume(rb);
		uint64_t now = clock_ns(CLOCK_MONOTONIC);
		if (now >= next) {
			uint32_t zero = 0;
			uint64_t dropped = 0;
			if (bpf_map_lookup_elem(lost, &zero, per_cpu) == 0)
				for (int i = 0; i < cpus; i++)
					dropped += per_cpu[i];
			printf("{\"ev\":\"clock\",\"lost\":%" PRIu64 ",\"mono\":%" PRIu64
			       ",\"records\":%" PRIu64 ",\"tai\":%" PRIu64 "}\n",
			       dropped, now, records, clock_ns(CLOCK_TAI));
			next += 1000000000ull;
		}
		fflush(stdout);
	}
}
