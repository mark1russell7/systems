/**
 * The results of the topology cells of step 3. T03 goes through a NAT router, T02 through HAProxy, and TOX
 * has Toxiproxy as the subject. A slice of T01 checks the generalized lab. Each cell has the frame of
 * `CellFrame`, with its warm-ups and its re-run. A cell of T03 also shows when the router forgot the flow.
 *
 * `Border` is the table of DV-12 on each side of the border of O03. `Slice` compares the slice of T01 with
 * the page of the network failures.
 */
import type { ReactElement, ReactNode } from "react";
import topologies from "../data/topologies-2026-10-16.json";
import { duration } from "../lib/format.ts";
import CellFrame, { code, joined, setting, sysctl } from "./CellFrame.tsx";
import { hopName } from "./Chain.tsx";
import Verdict from "./Verdict.tsx";

type Cell = (typeof topologies.cells)[number];
type Place = Cell["fault"]["at"];
type Observer = Cell["observer"];

const ms = (s: number): number => s * 1000;
const time = (s: number): string => duration(ms(s));

/** This function tells if a cell has a router, thus a time when the router forgot the flow. */
const routed = (cell: Cell): boolean => cell.topology.hops.some((hop) => hop.kind === "router");

/** This function gives the name of a hop of a cell in a sentence, by the name of the hop. */
const hopOf = (cell: Cell, name: string): string => {
  const hop = cell.topology.hops.find((each) => each.name === name);
  return hop === undefined ? name : hopName(hop);
};

/** This function gives the name of the place of a fault in a sentence. */
const placeName = (cell: Cell, place: Place): string => {
  if (place === "client") return "the client";
  if (place === "target") return "Redis";
  if (typeof place === "string") return place;
  const name = hopOf(cell, place.hop);
  return place.toward === null ? name : `${name} toward the ${place.toward}`;
};

/** This function gives the name of the observer of a cell in a sentence. */
const observerName = (cell: Cell, observer: Observer): string => {
  if (observer === "client") return "the client";
  if (observer === "server") return "the socket of Redis";
  if (typeof observer === "string") return observer;
  return `the socket of ${hopOf(cell, observer.hop)} toward the ${observer.toward}`;
};

/** These sentences tell what a router does with a flow that it forgot, for each form. */
const FORMS: Readonly<Record<string, string>> = {
  "reset-both": "When it forgets the flow, it sends a reset to the two ends.",
  "reset-next": "It answers the next packet from the client with a reset, and it drops a late packet from the server.",
  "silent-drop": "It drops each late packet, in each direction.",
  recreate: "It lets a late packet from the client through, and the flow starts again.",
  none: "It is a plain NAT router. A late packet from the client starts the flow again. The stack of the router answers a late packet from the server with a reset.",
};

/** This function gives the attributes of a toxic in code font. */
const attributes = (toxic: NonNullable<Cell["fault"]["toxic"]>): ReactNode => joined(toxic.attributes.map(({ name, value }) => setting(`${name} = ${value}`)));

/** This component tells the fault of a cell, where it is, and the observer. */
function Fault(props: { readonly cell: Cell }): ReactElement {
  const { cell } = props;
  const { fault, settings } = cell;
  const at = placeName(cell, fault.at);
  const router = cell.topology.hops.find((hop) => hop.kind === "router");
  const toxic = fault.toxic;
  const sentence = ((): ReactNode => {
    switch (fault.kind) {
      case "middlebox-forget":
        return (
          <>
            The router forgets a flow that is idle for {time(router?.idle ?? 0)}. Its form is {code(router?.form ?? "")}. {FORMS[router?.form ?? ""]}
          </>
        );
      case "proxy-idle": {
        const toward = typeof fault.at === "object" && fault.at.toward === "client" ? "client" : "target";
        const name = toward === "client" ? "timeout client" : "timeout server";
        const value = cell.topology.hops[0]?.settings.find((each) => each.name === name)?.value ?? "";
        return (
          <>
            {placeName(cell, typeof fault.at === "object" ? { hop: fault.at.hop, toward: null } : fault.at)} closes a connection that is idle for {value.replace(/s$/, " s")} on its side toward the {toward} ({setting(`${name} ${value}`)}).
          </>
        );
      }
      case "toxic":
        return toxic === null ? null : (
          <>
            The fault is the toxic {code(toxic.type)} on the {toxic.stream} stream of Toxiproxy, with {attributes(toxic)}.
          </>
        );
      case "server-close":
        return (
          <>
            Redis closes the connection with {code("CLIENT KILL")}.{" "}
            {toxic === null ? null : (
              <>
                The toxic {code(toxic.type)} is on the {toxic.stream} stream of Toxiproxy, with {attributes(toxic)}.
              </>
            )}
          </>
        );
      case "blackhole":
        return <>The fault is a black hole at {at}.</>;
      case "rst":
        return <>The fault is a reset of the next segment, at {at}.</>;
      case "netem":
        return settings.netem === null ? null : <>The target applies {code(`netem ${settings.netem}`)} to each segment that it sends.</>;
      case "unreachable":
        return <>The fault is an ICMP {fault.icmp} unreachable from {at}, for each segment of the observer.</>;
      case "simplex":
        return <>The fault drops each segment {fault.drops === "to-client" ? "to the client" : "to the server"}, at {at}.</>;
      case "mtu-blackhole":
        return <>The client drops each segment from the server that is longer than {settings.mtu} bytes.</>;
      case "freeze-process":
        return <>The cgroup freezer stops the process of {at}, and its kernel stays up.</>;
      case "fin":
        return <>The process of {at} stops with SIGKILL, and its kernel closes the socket with a FIN.</>;
      case "stall":
        return <>The fault is a black hole at {at} that stops by itself, {time(settings.stall ?? 0)} after the send of the request.</>;
      default:
        return <>The fault is {code(fault.kind)} at {at}.</>;
    }
  })();
  return (
    <p className="sy-muted">
      {sentence} The observer is {observerName(cell, cell.observer)}.
    </p>
  );
}

/** This component tells what a cell sets: the client, Redis, each proxy, the request, and O03 for a cell of T03. */
function Settings(props: { readonly cell: Cell }): ReactElement | null {
  const { cell } = props;
  const { settings, o03 } = cell;
  const parts: ReactElement[] = [];
  const client = joined(settings.client.map(sysctl));
  if (settings.client.length > 0 && settings.keepalive) parts.push(<span key="client">The client sets {client}, and its socket has {code("SO_KEEPALIVE")}. </span>);
  else if (settings.client.length > 0) parts.push(<span key="client">The client sets {client}. </span>);
  else if (settings.keepalive) parts.push(<span key="client">The socket of the client has {code("SO_KEEPALIVE")}. </span>);
  if (settings.target.length > 0) parts.push(<span key="target">The namespace of Redis has {joined(settings.target.map(sysctl))}. </span>);
  if (settings.redis.length > 0) parts.push(<span key="redis">Redis sets {joined(settings.redis.map(({ name, value }) => setting(`${name} ${value}`)))}. </span>);
  for (const hop of cell.topology.hops) {
    if (hop.kind !== "proxy") continue;
    const name = hopName(hop);
    if (hop.settings.length > 0) parts.push(<span key={`${hop.name} settings`}>{name} sets {joined(hop.settings.map(({ name: key, value }) => setting(`${key} ${value}`)))}. </span>);
    if (hop.sysctls.length > 0) parts.push(<span key={`${hop.name} sysctls`}>The namespace of {name} has {joined(hop.sysctls.map(sysctl))}. </span>);
  }
  if (settings.request !== null)
    parts.push(
      <span key="request">
        The client sends {code(settings.request)}
        {settings.bytes === null ? "" : ` for a value of ${settings.bytes} bytes`}.{" "}
      </span>,
    );
  if (settings.idleBefore !== null) parts.push(<span key="idle">The client is idle for {time(settings.idleBefore)} before it sends its request. </span>);
  if (settings.latency !== null) parts.push(<span key="latency">The target adds {time(settings.latency)} of latency to each segment that it sends. </span>);
  if (o03 !== null)
    parts.push(
      <span key="o03">
        {o03.refresh === null
          ? "O03 does not hold: nothing refreshes the flow."
          : `O03 ${o03.holds ? "holds" : "does not hold"}: the latest refresh is at ${time(o03.refresh)}, and the earliest forget of the router is at ${time(o03.forget)}.`}
      </span>,
    );
  return parts.length === 0 ? null : <p className="sy-muted">{parts}</p>;
}

function Details(props: { readonly cell: Cell }): ReactElement {
  return (
    <>
      <Fault cell={props.cell} />
      <Settings cell={props.cell} />
    </>
  );
}

/** The cells of one group of one catalog, in the sequence of the catalog. */
export default function TopologyResults(props: { readonly catalog: string; readonly group: string }): ReactElement {
  const cells = topologies.cells.filter((cell) => cell.catalog === props.catalog && cell.group === props.group);
  if (cells.length === 0) throw new Error(`no cell of ${props.catalog} has the group ${props.group}`);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => (
        <CellFrame key={cell.name} cell={cell} details={<Details cell={cell} />} forget={routed(cell)} />
      ))}
    </div>
  );
}

const find = (catalog: string, name: string): Cell => {
  const found = topologies.cells.find((cell) => cell.catalog === catalog && cell.name === name);
  if (found === undefined) throw new Error(`no cell ${catalog} ${name}`);
  return found;
};

/** This function gives the median of a set of numbers. */
const middle = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/**
 * The table of DV-12 as the program sees it. It puts the keepalive of the client on each side of the
 * border of O03, for each of the three forms. The router forgets an idle flow at 5 s. The window of a
 * broken O03 is the time that the client holds a connection that the router forgot.
 */
export function Border(): ReactElement {
  const at = (form: string, keepidle: number): Cell => find("T03", `client idle, ${form}, keepidle ${keepidle} s`);
  const [below, above] = [4, 6];
  const broken = at("reset-both", above);
  const kept = at("reset-both", below);
  const knob = (cell: Cell, name: string): number => Number(cell.settings.client.find((each) => each.name === `net.ipv4.tcp_keepalive_${name}`)?.value ?? NaN);
  const [K, I, P] = [knob(broken, "time"), knob(broken, "intvl"), knob(broken, "probes")];
  if (knob(kept, "time") !== below || K !== above) throw new Error("the cells of DV-12 have other keepalive times");
  const idle = broken.topology.hops[0]?.idle ?? NaN;
  const rows = [
    { form: "reset-both", formula: <code>0</code>, window: 0 },
    {
      form: "reset-next",
      formula: (
        <code>
          {"K − I"}
          <sub>x</sub>
        </code>
      ),
      window: K - idle,
    },
    {
      form: "silent-drop",
      formula: (
        <code>
          {"K + P·I − I"}
          <sub>x</sub>
        </code>
      ),
      window: K + P * I - idle,
    },
  ];
  const holds = (cell: Cell): string => (cell.o03?.holds === true ? "O03 holds" : "O03 does not hold");
  return (
    <div className="not-content">
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>
                Form
                <br />
                <span className="sy-muted">Window</span>
              </th>
              <th>
                Keepalive <span style={{ whiteSpace: "nowrap" }}>{below} s</span>
                <br />
                <span className="sy-muted">{holds(kept)}</span>
              </th>
              <th>
                Keepalive <span style={{ whiteSpace: "nowrap" }}>{above} s</span>
                <br />
                <span className="sy-muted">{holds(broken)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ form, formula, window }) => {
              const four = at(form, below);
              const six = at(form, above);
              const band = six.verdict.band;
              // the window of each counted run: from the forget of the router to the detection by the client
              const held = middle(six.runs.flatMap((run) => (run.void !== null || run.elapsed === null || run.forgot === null ? [] : [run.elapsed - run.forgot])));
              return (
                <tr key={form}>
                  <td>
                    {setting(form)}
                    <br />
                    <span style={{ whiteSpace: "nowrap" }}>{formula}</span>
                    <br />
                    <span style={{ whiteSpace: "nowrap" }}>= {window === 0 ? "0 s" : time(window)}</span>
                    <br />
                    <span className="sy-muted">{held === null ? "" : `measured ${time(held)}`}</span>
                  </td>
                  <td>
                    <Verdict decision={four.verdict.decision} text="silent" />
                    <br />
                    <span className="sy-muted">{four.verdict.counted} runs</span>
                  </td>
                  <td>
                    <Verdict decision={six.verdict.decision} text={six.verdict.median === null ? "none" : time(six.verdict.median)} />
                    <br />
                    <span className="sy-muted">{band === null ? "" : `${time(band.low)} to ${time(band.high)}`}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sy-muted">
        <span>
          {code("K")} = {K} s is the keepalive idle time of the client, {code("I")} = {I} s its interval, and {code("P")} = {P} its count of probes.{" "}
        </span>
        <span>
          <code>
            {"I"}
            <sub>x</sub>
          </code>{" "}
          = {idle} s is the idle timeout of the router.{" "}
        </span>
        <span>
          At {below} s, the latest refresh is at {time(kept.o03?.refresh ?? NaN)}, before the earliest forget at {time(kept.o03?.forget ?? NaN)}.{" "}
        </span>
        <span>
          At {above} s, the latest refresh is at {time(broken.o03?.refresh ?? NaN)}, after the forget.{" "}
        </span>
        <span>The measured window is the median, over the counted runs, of the time from the forget to the detection.</span>
      </p>
    </div>
  );
}

/** The table of the slice of T01. It gives the verdict and the median of each cell, on the page of the network failures and on the generalized lab. */
export function Slice(): ReactElement {
  const cells = topologies.cells.filter((cell) => cell.catalog === "T01");
  const text = (median: number | null): string => (median === null ? "silent" : time(median));
  return (
    <div className="not-content sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Cell</th>
            <th>Faults page, {topologies.faultsRanAt}</th>
            <th>This run, {topologies.ranAt}</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.name}>
              <td>{cell.name}</td>
              <td>{cell.faults === null ? "" : <Verdict decision={cell.faults.decision} text={text(cell.faults.median)} />}</td>
              <td>
                <Verdict decision={cell.verdict.decision} text={text(cell.verdict.median)} />
                {cell.rerun === null ? null : (
                  <span className="sy-again">
                    <Verdict decision={cell.rerun.verdict.decision} text={text(cell.rerun.verdict.median)} /> on the re-run
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
