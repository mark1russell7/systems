/**
 * These functions give the law of the search for a local port of a connect. The sources are Linux
 * v7.0, `__inet_hash_connect` in `net/ipv4/inet_hashtables.c`.
 *
 * - The search rounds the size of `ip_local_port_range` down to an even number, and it starts from
 *   an even offset. It takes steps of 2, thus each pass makes half of that number of tries (lines
 *   1066-1090). The second pass starts at the next offset, which has the other parity.
 * - A port is free for a destination when no connection holds its 4-tuple (lines 1099-1117). Thus
 *   the count is for each destination. When no try finds a free port, the connect fails with
 *   `EADDRNOTAVAIL` (lines 1146-1151).
 * - After each connect the start moves by 2 more than the larger of the tries and a random draw
 *   (lines 1175-1176). A failed search does not move it.
 *
 * An even range gets each port: the two passes reach each port. An odd range of `2k + 1` ports
 * makes `k` tries in each pass. Thus one port can stay out of reach of each try of a connect, and a
 * later connect from another start can reach it. `portSearchShares` gives the exact chance of each
 * count.
 */

/**
 * This size is the largest range of the exact chain. The states of the chain double with each port.
 * The tests of the package give the chain of 16 ports.
 */
export const PORT_SEARCH_CHAIN_LARGEST = 16;

const count = (value: number, what: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${what} is not a whole number above 0: ${value}`);
  return value;
};

/** This function gives the size that the search reads: the size of the range, rounded down to an even number. */
export const portSearchSpan = (size: number): number => {
  const ports = count(size, "the size of the range");
  return ports > 1 ? ports - (ports % 2) : ports;
};

/** One try of the search: the two passes from an even offset. It gives the port and the tries of its pass. */
const search = (size: number, span: number, taken: number, start: number): { port: number; tries: number } | null => {
  for (let offset = start; ; ) {
    for (let tries = 0, port = offset; tries < span; tries += 2, port += 2) {
      if (port >= size) port -= span;
      if (((taken >> port) & 1) === 0) return { port, tries };
    }
    offset += 1;
    if ((offset & 1) === 0 || span <= 1) return null;
  }
};

/** This function gives one round from one start: the chance of each pair of a count and the next start. */
const roundFrom = (size: number, start: number): Map<string, number> => {
  const span = portSearchSpan(size);
  const half = span / 2;
  const ends = new Map<string, number>();
  let states = new Map<string, number>([[`0|${start}`, 1]]);
  const add = (map: Map<string, number>, key: string, chance: number): void => {
    map.set(key, (map.get(key) ?? 0) + chance);
  };
  while (states.size > 0) {
    const next = new Map<string, number>();
    for (const [key, chance] of states) {
      const [taken, from] = key.split("|").map(Number) as [number, number];
      const found = search(size, span, taken, from);
      if (found === null) {
        add(ends, `${taken.toString(2).replaceAll("0", "").length}|${from}`, chance);
        continue;
      }
      // the step of the perturb table: 2 more than the larger of the tries and a random draw of 0 to 7, times 2
      for (let draw = 0; draw < 8; draw += 1) {
        const moved = ((from / 2 + (Math.max(found.tries, draw * 2) + 2) / 2) % half) * 2;
        add(next, `${taken | (1 << found.port)}|${moved}`, chance / 8);
      }
    }
    states = next;
  }
  return ends;
};

/**
 * This function gives the exact chain of the search: the share of each count of connects to one
 * destination, over `rounds` rounds. Each round closes its connections with a reset, and the next
 * round starts where the last connect of the round before put the start. The first round starts at
 * each even offset with the same chance.
 */
export const portSearchChain = (size: number, rounds = 400): ReadonlyMap<number, number> => {
  const ports = count(size, "the size of the range");
  count(rounds, "the count of rounds");
  if (ports > PORT_SEARCH_CHAIN_LARGEST)
    throw new Error(`the exact chain takes ${PORT_SEARCH_CHAIN_LARGEST} ports at most, not ${ports}`);
  if (ports === 1) return new Map([[1, 1]]);
  const half = portSearchSpan(ports) / 2;
  const table = Array.from({ length: half }, (_, at) => roundFrom(ports, at * 2));
  const total = new Map<number, number>();
  let start = Array.from({ length: half }, () => 1 / half);
  for (let round = 0; round < rounds; round += 1) {
    const after = Array.from({ length: half }, () => 0);
    start.forEach((chance, at) => {
      for (const [key, value] of table[at]!) {
        const [connects, next] = key.split("|").map(Number) as [number, number];
        after[next / 2]! += chance * value;
        total.set(connects, (total.get(connects) ?? 0) + (chance * value) / rounds);
      }
    });
    start = after;
  }
  return new Map([...total].sort((a, b) => a[0] - b[0]));
};

/**
 * This function gives the law of the search: the share of each count of connects to one
 * destination before `EADDRNOTAVAIL`, over `rounds` rounds. An even range, and a range of one
 * port, give their size in each round: the two passes reach each port. An odd range gives its
 * size or one less, from the exact chain, up to `PORT_SEARCH_CHAIN_LARGEST` ports.
 */
export const portSearchShares = (size: number, rounds = 400): ReadonlyMap<number, number> => {
  const ports = count(size, "the size of the range");
  count(rounds, "the count of rounds");
  if (ports === 1 || ports % 2 === 0) return new Map([[ports, 1]]);
  return portSearchChain(ports, rounds);
};
