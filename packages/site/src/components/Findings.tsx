/**
 * The findings of the home page, and the parts of the program. Each finding is the lead sentence of a
 * finding on its page of results, with a link to that page. A finding here has no number, thus it does not
 * get old when a copy of the results changes. The name of the page comes from the ledger.
 */
import type { ReactElement, ReactNode } from "react";
import { entryOf } from "../lib/ledger.ts";
import { link } from "./Ledger.tsx";

const FINDINGS: ReadonlyArray<{ readonly page: string; readonly tag: string; readonly anchor: string; readonly text: ReactNode }> = [
  { page: "faults", tag: "T01", anchor: "what-the-cells-found", text: <>An ICMP host or net unreachable ends a request sooner than a black hole does.</> },
  { page: "topologies", tag: "T02", anchor: "what-the-cells-found", text: <>The idle timeouts of HAProxy ignore TCP keepalive.</> },
  { page: "topologies", tag: "TOX", anchor: "what-the-cells-found", text: <>Toxiproxy changes resets and timeouts into normal closes.</> },
  {
    page: "sentinel",
    tag: "T12",
    anchor: "what-the-cells-found",
    text: (
      <>
        The plain <code>SENTINEL FAILOVER</code> loses writes, and the coordinated one does not.
      </>
    ),
  },
  { page: "http", tag: "T01", anchor: "what-the-cells-found", text: <>The pools of Node close late by a few milliseconds.</> },
  { page: "mongodb", tag: "T01 · T03", anchor: "what-the-cells-found", text: <>The monitor of the driver is not quiet under an ICMP host unreachable.</> },
  { page: "pg", tag: "T01", anchor: "what-the-cells-found", text: <>No timer of node-postgres ends a query at its defaults.</> },
  { page: "kind", tag: "T07", anchor: "what-the-cells-found", text: <>A stale conntrack entry catches a later connection.</> },
  { page: "calibration", tag: "Stage 0", anchor: "what-the-calibration-sets", text: <>More environments do not change the spread of keepalive.</> },
];

/** The findings, each in a card that links to its page. */
export default function Findings(): ReactElement {
  return (
    <ul className="sy-findings not-content">
      {FINDINGS.map((finding, n) => {
        const entry = entryOf(finding.page);
        return (
          <li key={n}>
            <a className="sy-finding" href={`${link(entry.href)}#${finding.anchor}`}>
              <span className="sy-caption">
                {entry.label} · {finding.tag}
              </span>
              <span>{finding.text}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const PARTS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  { name: "A corpus", text: "Each fact about a system is a claim. A claim has a unit, the conditions where it is true, its sources and its grade of evidence." },
  { name: "An algebra", text: "The algebra reads the state machines and the settings. It gives each timer a closed form, and a band for how late the timer fires." },
  { name: "A harness", text: "The harness starts each cell in fresh containers. It injects a fault, measures the result on one clock, and compares the result with the prediction." },
  { name: "A prober", text: "The prober is an eBPF program. It records what the kernel does to each socket, to the nanosecond." },
];

/** The four parts of the program. */
export function Parts(): ReactElement {
  return (
    <ul className="sy-parts not-content">
      {PARTS.map((part, n) => (
        <li key={part.name}>
          <div className="sy-finding">
            <span className="sy-caption">{`0${n + 1}`}</span>
            <strong>{part.name}</strong>
            <p>{part.text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
