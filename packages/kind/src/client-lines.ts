// The lines of the gRPC client of the lab image beside its calls: the connect and the close of each
// socket of its channel, and the gap of its calls. The client runs this module with Node, thus this
// module imports nothing.

/** A watched socket is the part of a socket of Node that the lines read. */
export interface WatchedSocket {
  once(event: "connect", listener: () => void): unknown;
  once(event: "close", listener: (hadError: boolean) => void): unknown;
  once(event: "error", listener: (error: Error & { readonly code?: string }) => void): unknown;
}

/** A say function writes one line of the client. The client adds its pod and its node. */
export type Say = (line: Readonly<Record<string, unknown>>) => void;

/**
 * This function writes a line `sock` at the connect of a socket and at its close, each with the stamp
 * of `now`. `port` gives the local port of the socket while its handle is open. The close line keeps
 * the port of the connect, because a closed handle has no port. It also gives the code of the first
 * error of the socket, or null for a close with no error.
 *
 * A prediction `ends` reads the close line: the end of the socket of the channel. A FIN of the peer
 * and a reset each end it.
 *
 * With `address`, the connect line also gives the local address of the socket (`la`): the address of
 * the pod. A prediction of the tunnels finds the HBONE connection of the ztunnel of the pod by it.
 */
export const followSocket = (socket: WatchedSocket, port: () => number | null, say: Say, now: () => number, address?: () => string | null): void => {
  let lp = port();
  let error: string | null = null;
  socket.once("error", (failure) => {
    error = failure.code ?? failure.message;
  });
  socket.once("connect", () => {
    lp = port() ?? lp;
    say({ ev: "sock", what: "connect", t: now(), lp, ...(address === undefined ? {} : { la: address() }) });
  });
  socket.once("close", (hadError) => {
    say({ ev: "sock", what: "close", t: now(), lp, err: hadError ? (error ?? "error") : null });
  });
};

/**
 * A gap is the state of the calls of a client. It is `stopped` from SIGUSR1 or SIGHUP to the next
 * SIGUSR2. It is `closed` from SIGHUP to the next SIGUSR2.
 */
export interface Gap {
  readonly stopped: boolean;
  readonly closed: boolean;
}

/** A channel is the part of the channel of a client that a gap closes and opens again. */
export interface Channel {
  close(): void;
  open(): void;
}

/** These are the signals of a gap. */
export type GapSignal = "SIGUSR1" | "SIGUSR2" | "SIGHUP";

/**
 * This function stops the calls of a client at SIGUSR1, and it starts them again at SIGUSR2. That is
 * the gap of the trigger `idle`. Each signal writes a line `gap` with the stamp of `now`, also when it
 * changes nothing. The channel and its socket stay open in the gap.
 *
 * With a `channel`, SIGHUP also stops the calls and closes the channel (`close`). Then the next
 * SIGUSR2 opens a new channel before it starts the calls (`open`, a line `gap` with `open: true`).
 */
export const gapOf = (on: (signal: GapSignal, listener: () => void) => unknown, say: Say, now: () => number, channel?: Channel): Gap => {
  const gap = { stopped: false, closed: false };
  on("SIGUSR1", () => {
    gap.stopped = true;
    say({ ev: "gap", what: "stop", t: now() });
  });
  on("SIGUSR2", () => {
    const open = gap.closed && channel !== undefined;
    if (open) {
      channel.open();
      gap.closed = false;
    }
    gap.stopped = false;
    say({ ev: "gap", what: "start", t: now(), ...(open ? { open: true } : {}) });
  });
  if (channel !== undefined)
    on("SIGHUP", () => {
      gap.stopped = true;
      if (!gap.closed) channel.close();
      gap.closed = true;
      say({ ev: "gap", what: "close", t: now() });
    });
  return gap;
};
