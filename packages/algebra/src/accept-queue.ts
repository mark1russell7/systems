/**
 * These functions give the counts of the accept queue of a TCP listener. The sources are Linux v6.6.
 *
 * - listen(2) clamps the backlog to `somaxconn` (`net/socket.c`, lines 1873-1879). The compare is
 *   unsigned, thus a negative backlog also gives `somaxconn`.
 * - The queue is full when `sk_ack_backlog > sk_max_ack_backlog` (`include/net/sock.h`, lines
 *   1033-1036). Thus the queue holds the limit plus one.
 *
 * The timers of a connection at a full queue are in the document of Linux TCP of
 * `@mark1russell7/machines`: `synack_retransmit` and `synack_giveup`.
 */

const count = (value: number, what: string): number => {
  if (!Number.isSafeInteger(value)) throw new Error(`${what} is not a whole number: ${value}`);
  return value;
};

/** This function gives the limit of the accept queue: the backlog of listen(2), clamped to `somaxconn`. */
export const acceptQueueLimit = (backlog: number, somaxconn: number): number => {
  const max = count(somaxconn, "somaxconn");
  if (max < 0) throw new Error(`somaxconn is less than 0: ${max}`);
  const asked = count(backlog, "the backlog");
  return asked < 0 || asked > max ? max : asked;
};

/** This function gives the connections that a full accept queue holds: its limit plus one. */
export const acceptQueueHeld = (backlog: number, somaxconn: number): number => acceptQueueLimit(backlog, somaxconn) + 1;
