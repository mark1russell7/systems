/**
 * The diagram of the chain of one catalog: the client, each hop and the target, from left to right. A
 * numbered mark is at each place where a cell of the catalog puts its fault. The list under the diagram
 * tells what each place gets. A catalog with cells on two chains gets two diagrams. The diagram draws at
 * its real width in pixels, so its text stays at its real size on a narrow page.
 */
import type { ReactElement, ReactNode } from "react";
import topologies from "../data/topologies-2026-10-16.json";
import { code, joined } from "./CellFrame.tsx";
import { useWidth } from "./Strip.tsx";

type Cell = (typeof topologies.cells)[number];
type Hop = Cell["topology"]["hops"][number];
type Place = Cell["fault"]["at"];

/** A node is one box of the chain: its name, then the lines that tell what it is. */
interface Node {
  readonly key: string;
  readonly lines: readonly string[];
  readonly hop: boolean;
}

/** These are the slots of the marks on a chain with one hop. They are the client, the two sides and the middle of the hop, and the target. */
const SLOTS = ["client", "hop toward client", "hop", "hop toward target", "target"] as const;

const PAD = 1;
/** the smallest space between two boxes */
const GAP = 22;
/** the widest box */
const WIDEST = 150;
const TOP = 14;
const LINE = 16;
const MARK = 9;

/** This function gives the name of a hop on the page, from its product or its kind. */
export const hopName = (hop: Hop): string => (hop.kind === "router" ? "the NAT router" : (hop.product ?? hop.name).split(" ")[0]!);

const nodesOf = (hops: readonly Hop[]): Node[] => {
  const [name, version] = topologies.target.split(":");
  return [
    { key: "client", lines: ["Client", "harness"], hop: false },
    ...hops.map((hop) =>
      hop.kind === "router"
        ? { key: hop.name, lines: ["NAT router", "conntrack", `idle ${hop.idle} s`], hop: true }
        : { key: hop.name, lines: [...(hop.product ?? hop.name).split(" "), ...(hop.mode === null ? [] : [`${hop.mode.toUpperCase()} mode`])], hop: true },
    ),
    { key: "target", lines: [name === "redis" ? "Redis" : (name ?? ""), version ?? ""], hop: false },
  ];
};

/** This function gives the slot of a place on the chain. */
const slotOf = (place: Place): (typeof SLOTS)[number] => {
  if (place === "client" || place === "target") return place;
  if (typeof place === "string") throw new Error(`no slot for ${place}`);
  return place.toward === null ? "hop" : place.toward === "client" ? "hop toward client" : "hop toward target";
};

/** This function gives the name of a slot of a chain in a sentence. */
const slotName = (slot: (typeof SLOTS)[number], hops: readonly Hop[]): string => {
  const hop = hops[0];
  const name = hop === undefined ? "" : hopName(hop);
  if (slot === "client") return "The client";
  if (slot === "target") return "Redis";
  if (slot === "hop") return name.charAt(0).toUpperCase() + name.slice(1);
  return `${name}, toward the ${slot === "hop toward client" ? "client" : "target"}`;
};

/** This function gives what one cell puts at each slot: its fault, and its toxic when the fault is something else. */
const faultsOf = (cell: Cell): Array<{ readonly slot: (typeof SLOTS)[number]; readonly what: string }> => {
  const { fault, settings } = cell;
  const at = slotOf(fault.at);
  const hop = cell.topology.hops[0];
  const toxic = fault.toxic === null ? [] : [{ slot: fault.toxic.stream === "downstream" ? ("hop toward client" as const) : ("hop toward target" as const), what: `toxic ${fault.toxic.type}` }];
  switch (fault.kind) {
    case "middlebox-forget":
      return [{ slot: at, what: "forget" }];
    case "proxy-idle": {
      const name = at === "hop toward client" ? "timeout client" : "timeout server";
      const value = hop?.settings.find((each) => each.name === name)?.value ?? "";
      return [{ slot: at, what: `idle ${name} ${value}` }];
    }
    case "toxic":
      return toxic;
    case "server-close":
      return [{ slot: at, what: "close" }, ...toxic];
    case "netem":
      return [{ slot: at, what: settings.netem === null ? `delay ${Math.round((settings.latency ?? 0) * 1000)}` : `netem ${settings.netem}` }];
    default:
      return [{ slot: at, what: fault.kind }];
  }
};

/** This function writes what a slot gets, from the faults of the cells there. */
const phrase = (whats: readonly string[], cells: readonly Cell[]): ReactNode => {
  const toxics = whats.filter((what) => what.startsWith("toxic ")).map((what) => what.slice("toxic ".length));
  const forms = [...new Set(cells.flatMap((cell) => cell.topology.hops.flatMap((hop) => (hop.form === null ? [] : [hop.form]))))];
  const parts: ReactNode[] = whats.flatMap((what): ReactNode[] => {
    if (what.startsWith("toxic ")) return [];
    if (what === "forget") {
      const idle = cells[0]?.topology.hops.find((hop) => hop.kind === "router")?.idle ?? 0;
      return [<span key={what}>it forgets each flow that is idle for {idle} s, with one of the forms {joined(forms.map(code))}</span>];
    }
    if (what.startsWith("idle ")) return [<span key={what}>the idle timeout {code(what.slice("idle ".length))}</span>];
    if (what === "close") return [<span key={what}>a close of the connection with {code("CLIENT KILL")}</span>];
    if (what.startsWith("delay ")) return [<span key={what}>a delay of {what.slice("delay ".length)} ms on each segment that it sends</span>];
    if (what.startsWith("netem ")) return [<span key={what}>{code(what)} on each segment that it sends</span>];
    const named: Readonly<Record<string, string>> = {
      blackhole: "a black hole",
      rst: "a reset of the next segment",
      unreachable: "an ICMP unreachable",
      simplex: "a drop in one direction",
      "mtu-blackhole": "a drop of each long segment",
      "freeze-process": "a frozen process",
      fin: "a FIN when its process stops",
      stall: "a stall",
    };
    return [<span key={what}>{named[what] ?? what}</span>];
  });
  if (toxics.length > 0) parts.push(<span key="toxics">{toxics.length === 1 ? "the toxic" : "the toxics"} {joined(toxics.map(code))}</span>);
  return joined(parts);
};

function Mark(props: { readonly n: number; readonly x: number; readonly y: number }): ReactElement {
  return (
    <g className="sy-mark">
      <circle cx={props.x} cy={props.y} r={MARK} />
      <text x={props.x} y={props.y + 4} textAnchor="middle">
        {props.n}
      </text>
    </g>
  );
}

function Diagram(props: { readonly nodes: readonly Node[]; readonly marks: ReadonlyArray<{ readonly n: number; readonly slot: (typeof SLOTS)[number] }>; readonly label: string }): ReactElement {
  const [ref, width] = useWidth();
  const { nodes } = props;
  const count = nodes.length;
  const box = Math.min(WIDEST, Math.floor((width - 2 * PAD - (count - 1) * GAP) / count));
  const gap = count === 1 ? 0 : (width - 2 * PAD - count * box) / (count - 1);
  const lines = Math.max(...nodes.map((node) => node.lines.length));
  const height = 20 + lines * LINE;
  const total = TOP + height + 4;
  const left = (n: number): number => PAD + n * (box + gap);
  const middle = TOP + height / 2;
  // a mark sits on the top edge of its box: at the side of a hop that faces the client or the target, or at the middle
  const markX = (slot: (typeof SLOTS)[number]): number => {
    if (slot === "client") return left(0) + box / 2;
    if (slot === "target") return left(count - 1) + box / 2;
    const hop = left(1);
    return slot === "hop" ? hop + box / 2 : slot === "hop toward client" ? hop + MARK + 6 : hop + box - MARK - 6;
  };
  return (
    <div ref={ref} className="sy-chain">
      <svg width={width} height={total} viewBox={`0 0 ${width} ${total}`} role="img" aria-label={props.label}>
        {nodes.slice(1).map((node, n) => (
          <line key={`link ${node.key}`} className="sy-link" x1={left(n) + box} x2={left(n + 1)} y1={middle} y2={middle} />
        ))}
        {nodes.map((node, n) => (
          <g key={node.key} className={node.hop ? "sy-node sy-hop" : "sy-node"}>
            <rect x={left(n)} y={TOP} width={box} height={height} rx={6} />
            {node.lines.map((line, k) => (
              <text key={k} className={k === 0 ? "sy-node-name" : undefined} x={left(n) + box / 2} y={TOP + 26 + LINE * k} textAnchor="middle">
                {line}
              </text>
            ))}
          </g>
        ))}
        {props.marks.map((mark) => (
          <Mark key={mark.n} n={mark.n} x={markX(mark.slot)} y={TOP} />
        ))}
      </svg>
    </div>
  );
}

/** The chain of each topology of a catalog, with the places of its faults. */
export default function Chain(props: { readonly catalog: string }): ReactElement {
  const cells = topologies.cells.filter((cell) => cell.catalog === props.catalog);
  if (cells.length === 0) throw new Error(`no cell has the catalog ${props.catalog}`);
  // a chain for each sequence of hops, the chain with hops first
  const chains = [...new Set(cells.map((cell) => cell.topology.hops.map((hop) => hop.name).join(" ")))].sort((a, b) => b.length - a.length);
  let next = 1;
  const drawn = chains.map((chain) => {
    const here = cells.filter((cell) => cell.topology.hops.map((hop) => hop.name).join(" ") === chain);
    const hops = here[0]!.topology.hops;
    const placed = here.flatMap((cell) => faultsOf(cell).map((each) => ({ ...each, cell })));
    const slots = SLOTS.filter((slot) => placed.some((each) => each.slot === slot));
    const marks = slots.map((slot) => ({
      n: next++,
      slot,
      whats: [...new Set(placed.filter((each) => each.slot === slot).map((each) => each.what))],
      cells: [...new Set(placed.filter((each) => each.slot === slot).map((each) => each.cell))],
    }));
    const nodes = nodesOf(hops);
    const names = nodes.map((node) => node.lines.join(" ")).join(", then ");
    const label = `The chain: ${names}. ${marks.length} ${marks.length === 1 ? "place gets" : "places get"} a fault.`;
    return { chain, hops, nodes, marks, label };
  });
  return (
    <section className="sy-panel not-content" aria-label={`The chain of ${props.catalog}`}>
      <div className="sy-body">
        {drawn.map(({ chain, hops, nodes, marks, label }) => (
          <div key={chain}>
            {drawn.length > 1 ? <p className="sy-caption">{hops.length === 0 ? "The direct pair" : `Through ${hopName(hops[0]!)}`}</p> : null}
            <Diagram nodes={nodes} marks={marks} label={label} />
            <ol className="sy-places">
              {marks.map((mark) => (
                <li key={mark.n}>
                  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="sy-mark">
                    <circle cx="10" cy="10" r={MARK} />
                    <text x="10" y="14" textAnchor="middle">
                      {mark.n}
                    </text>
                  </svg>
                  <span>
                    <strong>{slotName(mark.slot, hops)}</strong>: {phrase(mark.whats, mark.cells)}.
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
