/**
 * The lens of the NIC: it sends each segment of TCP, and it does not see a loss past its wire. The lens
 * reads the firings of the TCP lens for the same settings.
 */
import { format, quantity, valueIn } from "@mark1russell7/quantity";
import { say, type Fact, type Lens } from "../lens.ts";
import { count, type LayerId, type LayerResult, type Settings } from "../path.ts";
import { tcpModel } from "./tcp.ts";

/** This function gives what the NIC does: it sends each segment, and it does not see a loss past its wire. */
export const nicLane = (settings: Settings): LayerResult => {
  const tcp = tcpModel(settings).layer;
  const bits = valueIn(settings.mtu, "bit") * settings.txqueuelen;
  const drain = quantity(bits / valueIn(settings.rate, "bit/s"), "s");
  const sent = tcp.marks.filter((mark) => mark.kind === "fire" || mark.kind === "probe").length;
  const facts: Fact[] = [
    { label: "A full queue drains in", value: say(drain) },
    { label: "Segments it sends after the request", value: format(count(sent)) },
  ];
  return {
    id: "nic",
    verdict: "blind",
    band: null,
    summary:
      settings.fault === "stall"
        ? "The NIC sends the request and gets the ACK of the peer. The path works, thus the NIC has nothing to find."
        : `The NIC sends each segment, ${format(count(sent))} after the request. The loss is past its wire, thus its link stays up and its counters show no error.`,
    facts,
    marks: tcp.marks.filter((mark) => mark.kind === "fire" || mark.kind === "probe").map((mark) => ({ ...mark, kind: "fire" as const, label: `Sends: ${mark.label.toLowerCase()}` })),
    measured: [],
    warning: null,
  };
};

export const NIC: Lens<Settings, LayerId> = {
  id: "nic",
  names: { title: "The NIC", label: "NIC", short: "NIC", term: "NIC" },
  knobs: ["txqueuelen", "rate", "mtu"],
  lanes: (settings) => [nicLane(settings)],
};
