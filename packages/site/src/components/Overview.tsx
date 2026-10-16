/**
 * The first screen of the home page: what the program asks, how it answers, and the ledger of what it has
 * found. `Answers` gives the three answers at the defaults of Linux 6.6, from the model of the lab. Each
 * number on this screen comes from the model or from the copies of the results.
 */
import type { ReactElement } from "react";
import { duration } from "../lib/format.ts";
import { LINUX_66, detection, type Situation } from "../model/linux.ts";
import Ledger, { link } from "./Ledger.tsx";

export default function Overview(): ReactElement {
  return (
    <div className="sy-hero">
      <div className="sy-hero-text">
        <p className="sy-eyebrow">The systems program</p>
        <h1 id="_top">When does a client know that its peer is gone?</h1>
        <p className="sy-hero-lede">
          A client holds a connection, and its peer goes silent. The algebra computes the time until the client knows, from the rules of each system. The harness then injects the fault, measures
          the time on one clock, and compares it with the prediction.
        </p>
        <p className="sy-hero-note">The program starts at the TCP stack of Linux. It continues through proxies, databases and Kubernetes.</p>
        <div className="sy-actions">
          <a className="sy-action" data-primary="" href={link("lab/detection/")}>
            Open the lab
          </a>
          <a className="sy-action" href={link("thesis/")}>
            Read the thesis
          </a>
          <a className="sy-action" href={link("results/cells/")}>
            See the results
          </a>
        </div>
      </div>
      <Ledger />
    </div>
  );
}

const SITUATIONS: ReadonlyArray<{ readonly situation: Situation; readonly label: string }> = [
  { situation: "idle", label: "An idle connection" },
  { situation: "in-flight", label: "A request in flight" },
  { situation: "frozen", label: "A frozen process" },
];
const DETECTORS: Readonly<Record<string, string>> = { keepalive: "Keepalive tells it.", retransmission: "The give-up of the retransmissions tells it." };

/** The three answers at the defaults of Linux 6.6: when a black hole or a frozen peer reaches the client. */
export function Answers(): ReactElement {
  return (
    <dl className="sy-answers not-content">
      {SITUATIONS.map(({ situation, label }) => {
        const found = detection(LINUX_66, situation, true);
        return (
          <div key={situation}>
            <dt>{label}</dt>
            <dd>{found.bounds === null ? "never" : duration(found.bounds.duration)}</dd>
            <dd className="sy-answers-why">{found.timer === null ? "No TCP timer fires." : DETECTORS[found.timer]}</dd>
          </div>
        );
      })}
    </dl>
  );
}
