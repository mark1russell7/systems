/**
 * The lens of the socket: the write ends at once, and the error of TCP arrives at the next read. The
 * socket shows what TCP below it decides, thus the lens reads the model of the TCP lens.
 */
import { errnoOf } from "@mark1russell7/automata";
import { LINUX_TCP } from "@mark1russell7/machines";
import { sayBand, type Fact, type Lens, type Mark } from "../lens.ts";
import { manifestationOf, type LayerId, type LayerResult, type Settings } from "../path.ts";
import { tcpModel } from "./tcp.ts";

/** This function gives what the socket shows for the settings. */
export const socketLane = (settings: Settings): LayerResult => {
  const { layer: tcp, found } = tcpModel(settings);
  const facts: Fact[] = [];
  const marks: Mark[] = [];
  const manifestation = manifestationOf(settings.fault);
  const first = found.first;
  const errno = first === null ? null : errnoOf(LINUX_TCP, "ESTABLISHED", first, manifestation);
  if (tcp.verdict === "detects" && tcp.band !== null) marks.push({ t: tcp.band.low, label: `The next read returns ${errno ?? "an error"}`, kind: "detect" });
  facts.push({ label: "The write", value: "returns at once" });
  facts.push({ label: "Send queue", value: settings.inFlight && settings.fault !== "stall" ? "the request, until an ACK" : "empty" });
  return {
    id: "socket",
    verdict: tcp.verdict === "detects" ? "detects" : tcp.verdict === "recovers" ? "recovers" : "blind",
    band: tcp.verdict === "blind" ? null : tcp.band,
    summary:
      tcp.verdict === "detects" && tcp.band !== null
        ? `The socket shows nothing until TCP gives up. At ${sayBand(tcp.band)}, the next read or write returns ${errno ?? "an error"}.`
        : tcp.verdict === "recovers" && tcp.band !== null
          ? `The socket shows no error. The request waits in the send queue, and the reply arrives late, at ${sayBand(tcp.band)}.`
          : settings.fault === "stall"
            ? "The kernel of the peer acknowledges the request, thus the send queue empties. The reply does not come, and the read waits."
            : "The socket shows no error. The write went into the send buffer, and the read waits.",
    facts,
    marks,
    measured: [],
    warning: null,
  };
};

export const SOCKET: Lens<Settings, LayerId> = {
  id: "socket",
  names: { title: "The socket", label: "Socket", short: "Socket", term: "socket" },
  knobs: [],
  lanes: (settings) => [socketLane(settings)],
};
