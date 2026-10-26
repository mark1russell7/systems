import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity } from "@mark1russell7/quantity";
import type { Clock } from "../clock.ts";
import { realClock } from "../clock.ts";
import { ms, timeProblems, wrapperTimerProblems, zeroProblems } from "../client/core.ts";
import type { Heartbeat } from "../heartbeat.ts";
import { heartbeat } from "../heartbeat.ts";

/**
 * These are the knobs of the session check of an HTTP/2 client. They have the names and the units of
 * the gRPC client, because the check is the same PING. The grpc-js driver ends its transport at the first PING with no ACK.
 */
export interface SessionCheckKnobs {
  /**
   * This time is the quiet interval of a session. A tick comes at each interval, and it sends a PING
   * when the session heard nothing since the last tick. "infinite" sends no PING.
   */
  readonly keepalive_time: Extent;
  /** This time bounds the ACK of each PING. With no ACK in it, the check closes the session. */
  readonly keepalive_timeout: Quantity;
}

/**
 * A session is the part of an HTTP/2 session that the check uses. A `ClientHttp2Session` of
 * `node:http2` has each member, thus the check does not load `node:http2`.
 */
export interface H2Session {
  /** This flag is true until the socket of the session connects. */
  readonly connecting: boolean;
  /** This method sends a PING. The callback gets null at the ACK, and an error otherwise. It gives false when the PING did not go. */
  ping(callback: (error: Error | null) => void): boolean;
  /** This method ends the session and each stream on it at once. */
  destroy(error?: Error): void;
}

/** A close is the part of the check that closed the session. */
export type SessionClose = "stream timeout" | "no PING answer";

/** These options make a session check. */
export interface SessionCheckOptions {
  readonly knobs: SessionCheckKnobs;
  /**
   * True lets a quiet session with no stream get a PING, as the option of the gRPC client does.
   * The default is false: a server can refuse a PING with no stream (O26).
   */
  readonly keepaliveWithoutCalls?: boolean | undefined;
  /** This clock gives the ticks and the timeouts. The default is `realClock`. */
  readonly clock?: Clock | undefined;
  /** This function receives the close of the session by the check, with its cause. */
  readonly onClose?: ((cause: SessionClose) => void) | undefined;
}

/**
 * A session check closes an HTTP/2 session that stopped answering. The caller tells it of each
 * stream and of each frame from the peer. The next stream of the caller then opens a new session.
 */
export interface SessionCheck {
  /** This method tells the check that a stream started on the session. */
  opened(): void;
  /** This method tells the check that a stream ended with an answer or an error. */
  ended(): void;
  /** This method tells the check that a stream ended at its timeout. The check then closes the session. */
  timedOut(): void;
  /** This method tells the check that a frame came from the peer, for example a response or the SETTINGS of the peer. */
  heard(): void;
  /** This method stops the check, and the session stays. A second use does nothing. */
  stop(): void;
  /** This count is the streams in flight on the session. */
  readonly streams: number;
  /** This cause is why the check closed the session, or null while it did not. */
  readonly closed: SessionClose | null;
}

/** This code is on the error that ends each stream of a session that the check closes. */
export const SESSION_CHECK_CLOSE = "ERR_SESSION_CHECK";

/**
 * This function starts the check of one HTTP/2 session. It has two parts:
 * - A stream that times out closes its session, and not only the stream. On HTTP/1.1, a request
 *   that times out destroys its socket. On HTTP/2, the session is the connection.
 * - The heartbeat of the package sends a PING after a quiet interval. With no ACK in
 *   `keepalive_timeout`, it closes the session.
 *
 * A session that has not connected cannot answer a PING. Thus its tick waits for the SETTINGS of the
 * peer through `heard()`, in `keepalive_timeout`.
 */
export const sessionCheck = (session: H2Session, options: SessionCheckOptions): SessionCheck => {
  const { knobs, keepaliveWithoutCalls = false, clock = realClock } = options;
  let streams = 0;
  let heardSince = false;
  let closed: SessionClose | null = null;

  const close = (cause: SessionClose, why: string): void => {
    if (closed !== null) return;
    closed = cause;
    beat.stop();
    session.destroy(Object.assign(new Error(`the session check closed the session: ${why}`), { code: SESSION_CHECK_CLOSE }));
    options.onClose?.(cause);
  };

  const beat: Heartbeat = heartbeat({
    interval: ms(knobs.keepalive_time),
    timeout: ms(knobs.keepalive_timeout),
    misses: 1,
    clock,
    due: () => {
      const quiet = !heardSince;
      heardSince = false;
      return closed === null && quiet && (keepaliveWithoutCalls || streams > 0);
    },
    ping: () => {
      // the answer of a session that connects is the SETTINGS of the peer, through heard()
      if (session.connecting) return undefined;
      return new Promise<boolean>((resolve) => {
        try {
          if (!session.ping((error) => resolve(error === null))) resolve(false);
        } catch {
          resolve(false);
        }
      });
    },
    onDead: () => close("no PING answer", "no PING ACK in keepalive_timeout"),
  });

  return {
    opened() {
      streams += 1;
    },
    ended() {
      streams = Math.max(0, streams - 1);
    },
    timedOut() {
      streams = Math.max(0, streams - 1);
      close("stream timeout", "a stream timed out");
    },
    heard() {
      heardSince = true;
      beat.answer();
    },
    stop() {
      beat.stop();
    },
    get streams() {
      return streams;
    },
    get closed() {
      return closed;
    },
  };
};

/**
 * This function gives the most time from the last frame of the peer to the close of a session by the
 * PING. The first quiet tick comes up to two intervals after that frame, and its PING then waits
 * `keepalive_timeout`. "infinite" is a check with no PING. Then only a stream timeout closes the session.
 */
export const sessionCheckDetection = (knobs: SessionCheckKnobs): Extent =>
  knobs.keepalive_time.value === "infinite"
    ? { value: "infinite", unit: "s" }
    : quantity((2 * ms(knobs.keepalive_time) + ms(knobs.keepalive_timeout)) / 1000, "s");

/**
 * This function gives the problems of the knobs of a session check. Each knob is a time of zero or
 * more. `keepalive_time` is "infinite" for no PING, and not zero. `keepalive_timeout` is a finite time
 * above zero, because the check is the only bound of the PING.
 */
export const sessionCheckProblems = (name: string, knobs: SessionCheckKnobs): string[] => {
  const times = timeProblems(name, knobs);
  if (times.length > 0) return times;
  return [
    ...zeroProblems(name, "the session check", knobs, { open: ["keepalive_time"] }),
    ...wrapperTimerProblems(name, knobs, { keepalive_timeout: "a PING" }),
  ];
};
