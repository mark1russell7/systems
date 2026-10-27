// The placement of the sessions of the HTTP/2 client of the lab image. The lab writes the backend of
// each slot of the client (`placementOf`), and the next SIGHUP opens each slot again until its first
// answer comes from that backend. The client runs this module with Node, thus this module imports nothing.

/** A placed slot is a session of a slot, the backend of its first answer (`b`), its tries, and if that backend is the wanted one. */
export interface Placed<H> {
  readonly held: H;
  readonly b: string | null;
  readonly tries: number;
  readonly ok: boolean;
}

/**
 * This function opens a session for one slot until its first answer comes from the wanted backend,
 * for `tries` sessions at the most. Each session of the wrong backend closes. The rules pick the backend of each new
 * session, thus each try reaches the wanted backend at random or in turn. After the last try, the slot
 * keeps its last session, and `ok` is false.
 */
export const placeSlot = async <H>(
  open: () => H,
  probe: (held: H) => Promise<string | null>,
  close: (held: H) => void,
  wanted: string,
  tries: number,
): Promise<Placed<H>> => {
  if (!Number.isInteger(tries) || tries < 1) throw new RangeError(`a placement needs one try at the least, not ${tries}`);
  for (let tried = 1; ; tried += 1) {
    const held = open();
    const b = await probe(held);
    if (b === wanted || tried === tries) return { held, b, tries: tried, ok: b === wanted };
    close(held);
  }
};

/** This function reads a placement: a list of the names of the backends of the slots, one for each slot. Any other text gives null. */
export const placementFrom = (text: string, slots: number): string[] | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length === slots && parsed.every((each) => typeof each === "string" && each !== "") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
};
