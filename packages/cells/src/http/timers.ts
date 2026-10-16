import type { Expr } from "@mark1russell7/algebra";

/**
 * This module gives the lateness of a timer in user space on Linux 6.6. A Node timer and a Go timer
 * both sleep in `epoll_wait` with a timeout in whole milliseconds. The kernel lets that sleep end
 * late by a slack, and the loop reads its clock in whole milliseconds.
 *
 * The facts, each from the source at its version:
 * - `fs/eventpoll.c:1836` (Linux v6.6) takes the slack from `select_estimate_accuracy`, and
 *   `fs/eventpoll.c:1921` sleeps with `schedule_hrtimeout_range(to, slack)`. Thus the wake comes
 *   in [due, due + slack].
 * - `fs/select.c:51-74` makes the slack the remaining time divided by 1000, at most 100 ms
 *   (`MAX_SLACK`). A task with a nice value above 0 divides by 200.
 * - `fs/select.c:91-92` and `init/init_task.c:133` make the slack 50 µs at the minimum
 *   (`timer_slack_ns`).
 * - libuv 1.52.1 (`deps/uv/src/unix/linux.c:1451` in Node v24.21.0) calls `epoll_pwait` with the
 *   timeout in milliseconds. `deps/uv/src/timer.c:143-160` gives that timeout as the due time
 *   less the loop clock, in milliseconds.
 * - `deps/uv/src/unix/internal.h:467-470` truncates the loop clock to milliseconds.
 *   `deps/uv/src/unix/linux.c:1603-1629` reads `CLOCK_MONOTONIC` for that clock when
 *   `CLOCK_MONOTONIC_COARSE` is coarser than 1 ms. At HZ 250 the coarse clock has 4 ms steps.
 * - Node stamps the start of a timer with the loop clock (`lib/internal/timers.js:426-429`,
 *   `src/env.cc:1649-1651`). It starts the callback of a timer when the loop clock less that start
 *   is the duration or more (`lib/internal/timers.js:631-641`). Thus the start can be up to 1 ms
 *   before the arming.
 * - Go 1.27.2 sleeps in `epoll_wait` with the delay truncated to milliseconds, and with 1 ms when
 *   less than 1 ms remains (`src/runtime/netpoll_epoll.go:117-133`). A Go timer does not fire
 *   early: a wake before the due time sleeps again.
 *
 * The time that the loop itself spends in callbacks is the time of the application. These
 * documents do not bound it, and the noise of the harness (δ_abs) holds a small part of it.
 */

/** This text is the slack of `epoll_wait` for a sleep of `ms` milliseconds, in milliseconds. */
const slackMs = (ms: string): string => `min(max((${ms}) / 1000, 0.05), 100)`;

/**
 * This function gives the lateness of a Node timer of `ms` milliseconds. The lateness is the slack
 * of its sleep, and 1 ms for the truncation of the loop clock and of the timeout. The arithmetic
 * reads `ms` in milliseconds.
 */
export const nodeTimerLateness = (ms: string): Expr => ({ expr: `${slackMs(ms)} + 1`, unit: "ms" });

/** This expression is how early a Node timer can fire: 1 ms, because the loop clock that stamps its start is truncated. */
export const NODE_TIMER_EARLY: Expr = { const: 1, unit: "ms" };

/** This function gives the lateness of a Go timer of `s` seconds: the slack of its sleep and 1 ms. The arithmetic reads `s` in seconds. */
export const goTimerLateness = (s: string): Expr => ({
  expr: `min(max((${s}) / 1000, 0.00005), 0.1) + 0.001`,
  unit: "s",
});

/** This function gives the lateness of a Node timer of `seconds`, in seconds: the number form of `nodeTimerLateness`. */
export const nodeLateSeconds = (seconds: number): number =>
  (Math.min(Math.max(seconds, 0.05), 100) + 1) / 1000;

/** This time is how early a Node timer can fire, in seconds: the number form of `NODE_TIMER_EARLY`. */
export const NODE_EARLY_SECONDS = 0.001;

/** This function gives the lateness of a Go timer of `seconds`, in seconds: the number form of `goTimerLateness`. */
export const goLateSeconds = (seconds: number): number => Math.min(Math.max(seconds / 1000, 0.00005), 0.1) + 0.001;

/**
 * This count is the tick of the fast timers of undici 8.12.2, in milliseconds:
 * `(RESOLUTION_MS >> 1) - 1` with `RESOLUTION_MS` 1000 (`lib/util/timers.js:30-40`).
 */
export const UNDICI_TICK_MS = 499;

/**
 * This function gives how early a fast timer of undici can fire, for a duration of `ms`
 * milliseconds. Each tick adds the tick to the clock of the fast timers, whatever time passed
 * (`lib/util/timers.js:115-123`). A new timer takes the clock of the next tick less one tick as its
 * start (`lib/util/timers.js:151-155`). It fires at the first tick where the clock is its start
 * plus its duration or more (`lib/util/timers.js:156-162`). Thus it fires after
 * `ceil(ms / 499) - 1` ticks and part of one more tick.
 */
export const undiciFastEarly = (ms: string): Expr => ({
  expr: `(${ms}) - (ceil((${ms}) / ${UNDICI_TICK_MS}) - 1) * ${UNDICI_TICK_MS}`,
  unit: "ms",
});

/**
 * This function gives how late a fast timer of undici can fire, for a duration of `ms`
 * milliseconds. It fires after at most `ceil(ms / 499)` whole ticks. Each tick is a Node timer
 * of 499 ms (`lib/util/timers.js:190-207`), with the lateness of a Node timer.
 */
export const undiciFastLateness = (ms: string): Expr => ({
  expr:
    `ceil((${ms}) / ${UNDICI_TICK_MS}) * ${UNDICI_TICK_MS} - (${ms})` +
    ` + ceil((${ms}) / ${UNDICI_TICK_MS}) * (${slackMs(String(UNDICI_TICK_MS))} + 1)`,
  unit: "ms",
});
