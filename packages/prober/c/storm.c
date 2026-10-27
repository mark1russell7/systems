/* storm CONNECTIONS THREADS
 *
 * The comparison's workload: a storm of short TCP connections over loopback, in the namespace the
 * collectors watch. Each connection connects, sends 64 bytes, reads them echoed back and closes,
 * so the kernel writes every kind of record a connection's life has: state changes, the request
 * sock and the accept, segments received, the close into TIME_WAIT, and destruction. THREADS
 * clients and as many servers operate at the same time. It prints how many connections it made, and in how
 * long, as one JSON line.
 */
#include <arpa/inet.h>
#include <inttypes.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static int listener;
static struct sockaddr_in where;
static long per_thread;
static atomic_long made, failed;

static uint64_t now_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static void *serve(void *unused)
{
	(void)unused;
	char buf[64];
	for (;;) {
		int fd = accept(listener, NULL, NULL);
		if (fd < 0)
			continue;
		ssize_t got = read(fd, buf, sizeof(buf));
		if (got > 0)
			(void)!write(fd, buf, (size_t)got);
		close(fd);
	}
	return NULL;
}

static void *storm(void *unused)
{
	(void)unused;
	char buf[64];
	memset(buf, 'x', sizeof(buf));
	for (long i = 0; i < per_thread; i++) {
		int fd = socket(AF_INET, SOCK_STREAM, 0);
		if (fd < 0 || connect(fd, (struct sockaddr *)&where, sizeof(where)) != 0 ||
		    write(fd, buf, sizeof(buf)) != (ssize_t)sizeof(buf) || read(fd, buf, sizeof(buf)) <= 0) {
			atomic_fetch_add(&failed, 1);
		} else {
			atomic_fetch_add(&made, 1);
		}
		if (fd >= 0)
			close(fd);
	}
	return NULL;
}

int main(int argc, char **argv)
{
	if (argc != 3) {
		fprintf(stderr, "usage: storm CONNECTIONS THREADS\n");
		return 2;
	}
	long connections = atol(argv[1]);
	int threads = atoi(argv[2]);
	if (connections <= 0 || threads <= 0 || threads > 64) {
		fprintf(stderr, "storm: CONNECTIONS > 0, 0 < THREADS <= 64\n");
		return 2;
	}
	per_thread = connections / threads;

	listener = socket(AF_INET, SOCK_STREAM, 0);
	int one = 1;
	setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	where.sin_family = AF_INET;
	where.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	where.sin_port = 0;
	socklen_t len = sizeof(where);
	if (bind(listener, (struct sockaddr *)&where, sizeof(where)) != 0 || listen(listener, 4096) != 0 ||
	    getsockname(listener, (struct sockaddr *)&where, &len) != 0) {
		perror("storm: listen");
		return 1;
	}
	pthread_t servers[64], clients[64];
	for (int i = 0; i < threads; i++)
		pthread_create(&servers[i], NULL, serve, NULL);
	uint64_t start = now_ns();
	for (int i = 0; i < threads; i++)
		pthread_create(&clients[i], NULL, storm, NULL);
	for (int i = 0; i < threads; i++)
		pthread_join(clients[i], NULL);
	uint64_t took = now_ns() - start;
	printf("{\"connections\":%ld,\"failed\":%ld,\"threads\":%d,\"ns\":%" PRIu64 "}\n",
	       atomic_load(&made), atomic_load(&failed), threads, took);
	return 0;
}
