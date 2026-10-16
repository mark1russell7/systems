/**
 * The results of the network-fault cells of T01, for one manifestation. Each cell has the frame of
 * `CellFrame`. The frame has a chart of the runs against the band of the prediction, the prediction, the
 * settings and the verdict. A cell without a band is a measurement only. Its chart shows the fastest, the
 * median and the slowest reply of each run.
 */
import type { ReactElement } from "react";
import faults from "../data/faults-2026-10-14.json";
import { duration } from "../lib/format.ts";
import CellFrame, { code, joined, setting, sysctl } from "./CellFrame.tsx";

type Cell = (typeof faults.cells)[number];

const ms = (s: number): number => s * 1000;

/** This component tells what the cell sets: the sysctls of each side, the settings of Redis and the fault itself. */
function Settings(props: { readonly cell: Cell }): ReactElement {
  const { settings } = props.cell;
  const parts: ReactElement[] = [];
  if (settings.observer.length > 0) parts.push(<span key="observer">The observer sets {joined(settings.observer.map(sysctl))}. </span>);
  if (settings.peer.length > 0) parts.push(<span key="peer">The sender of the ICMP sets {joined(settings.peer.map(sysctl))}. </span>);
  if (settings.redis.length > 0) parts.push(<span key="redis">Redis sets {joined(settings.redis.map(({ name, value }) => setting(`${name} ${value}`)))}. </span>);
  if (settings.latency !== null) parts.push(<span key="latency">The target adds {duration(ms(settings.latency))} of latency to each segment that it sends. </span>);
  if (settings.stall !== null) parts.push(<span key="stall">The stall lasts {duration(ms(settings.stall))} from the send of the request. </span>);
  if (settings.mtu !== null) parts.push(<span key="mtu">Each segment to the client that is longer than {settings.mtu} bytes drops. </span>);
  if (settings.netem !== null) parts.push(<span key="netem">The target applies {code(`netem ${settings.netem}`)} to each segment that it sends. </span>);
  if (parts.length === 0) parts.push(<span key="none">The observer has the Linux 6.6 values of each TCP setting.</span>);
  return <p className="sy-muted">{parts}</p>;
}

/** The cells of one manifestation, in the sequence of the catalog. */
export default function FaultResults(props: { readonly manifestation: string }): ReactElement {
  const cells = faults.cells.filter((cell) => cell.manifestation === props.manifestation);
  if (cells.length === 0) throw new Error(`no cell has the manifestation ${props.manifestation}`);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => (
        <CellFrame key={cell.name} cell={cell} details={<Settings cell={cell} />} />
      ))}
    </div>
  );
}
