// The counters of the dropped packets of a node and of its client pods. The agent of each node
// reads them each second, and the image copies this file, thus it imports nothing.

/** This function gives the values of one protocol of `/proc/net/snmp`: a line of names, then a line of values. */
export const snmpOf = (text: string, protocol: string): Record<string, number> => {
  const lines = text.split("\n").filter((line) => line.startsWith(`${protocol}:`));
  if (lines.length < 2) return {};
  const names = lines[0]!.trim().split(/\s+/).slice(1);
  const values = lines[1]!.trim().split(/\s+/).slice(1).map(Number);
  return Object.fromEntries(names.map((name, at) => [name, values[at] ?? 0]));
};

/** These are the dropped packets of one interface: received and sent. */
export interface InterfaceDrops {
  readonly rx: number;
  readonly tx: number;
}

/** This function gives the dropped packets of each interface of `/proc/net/dev`. The fourth field of each direction is its drops. */
export const devOf = (text: string): Record<string, InterfaceDrops> => {
  const out: Record<string, InterfaceDrops> = {};
  for (const line of text.split("\n").slice(2)) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    out[match[1]!] = { rx: fields[3] ?? 0, tx: fields[11] ?? 0 };
  }
  return out;
};

/**
 * This function gives two sums over the CPUs of `/proc/net/softnet_stat`. The first is the packets
 * that a full backlog dropped. The second is the times that a softirq used all of its budget. Each
 * line is one CPU in hexadecimal: the processed packets, the drops, then the squeezes.
 */
export const softnetOf = (text: string): { readonly dropped: number; readonly squeezed: number } => {
  let dropped = 0;
  let squeezed = 0;
  for (const line of text.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    dropped += parseInt(fields[1]!, 16);
    squeezed += parseInt(fields[2]!, 16);
  }
  return { dropped, squeezed };
};

/** This function counts the entries of `/proc/net/arp` with no address yet (flags 0x0). A packet to such a neighbor waits in a queue, then drops. */
export const unresolvedOf = (text: string): number =>
  text
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "" && line.trim().split(/\s+/)[2] === "0x0").length;

/** This function gives each counter that grew from one read to the next, with its growth. A counter of the second read only is not in it. */
export const grownOf = (before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(after)) {
    const last = before[name];
    if (last !== undefined && value > last) out[name] = value - last;
  }
  return out;
};
