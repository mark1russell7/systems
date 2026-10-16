import type { Extent, Quantity, Rational, Unknown } from "@mark1russell7/quantity";
import {
  convertExact,
  isUnbounded,
  quantity,
  rationals as r,
  unbounded,
} from "@mark1russell7/quantity";
import type { Expr, Machine, TransitionDef } from "./machine.ts";
import { FIRED, arr, exprKnobs, fromStates } from "./machine.ts";

/**
 * This module has the closed forms of the algebra. They give the duration of a timer of a
 * machine, and how late and how early it can fire, from the values of its knobs.
 *
 * A machine document writes each duration in one of four forms (`machine.ts`): a constant, a knob,
 * arithmetic over its knobs, or a named model. The arithmetic uses the value of each knob in the
 * unit that the document gives to that knob. Thus `tcp_keepalive / 3` of Redis divides whole
 * seconds, as Redis does. A model is the formula of the implementation itself, for example the
 * retransmission budget of the kernel. The values are exact rationals, not floats: 0.2 s × 1023
 * is 204.6 s, not 204.60000000000002.
 *
 * A knob without a value makes the result unknown, and the result names the knob. A knob that
 * nothing sets (no bound) makes a duration without an end.
 */

/** This function gives the value of each knob, by the name of the machine for it: an amount, no bound, or unknown and the reason. */
export type KnobValues = (name: string) => Extent | Unknown | undefined;

/** Timer bounds tell how long a timer operates, how late it can fire and how early, each in the unit of its document. */
export interface TimerBounds {
  readonly duration: Extent | Unknown;
  readonly lateness?: Extent | Unknown | undefined;
  readonly early?: Extent | Unknown | undefined;
}

/**
 * A value is an exact rational, no bound, or unknown with its reason. No bound has a sign. A
 * duration is not negative, but a step of the arithmetic can be: cap − ∞ is −∞, and
 * max(cap − ∞, cap / 2) is cap / 2.
 */
type Value =
  | { readonly kind: "exact"; readonly n: Rational }
  | { readonly kind: "infinite"; readonly negative?: true }
  | { readonly kind: "unknown"; readonly why: string };

const exact = (n: Rational): Value => ({ kind: "exact", n });
const INFINITE: Value = { kind: "infinite" };
const NEGATIVE_INFINITE: Value = { kind: "infinite", negative: true };
/** This function gives the sign of a value that is not unknown: −1, 0 or 1. */
const signOf = (value: Value): number =>
  value.kind === "infinite"
    ? value.negative === true
      ? -1
      : 1
    : value.kind === "exact"
      ? r.cmp(value.n, r.ZERO)
      : 0;
/** This function gives no bound with a sign. */
const unboundedOf = (sign: number): Value => (sign < 0 ? NEGATIVE_INFINITE : INFINITE);
const unknown = (why: string): Value => ({ kind: "unknown", why });
const whole = (n: bigint): Rational => r.rational(n);

/** This function gives the first unknown among some values. An operation over them gets it. */
const unknownOf = (values: readonly Value[]): Value | undefined =>
  values.find((value) => value.kind === "unknown");

// ---------------------------------------------------------------------------------------------
// the arithmetic of the documents: + - * /, min, max, floor, ceil, parentheses, numbers, knob names
// ---------------------------------------------------------------------------------------------

/** A node is the arithmetic of a document, after the parse. */
export type Node =
  | { readonly op: "num"; readonly n: Rational }
  | { readonly op: "knob"; readonly name: string }
  | { readonly op: "+" | "-" | "*" | "/"; readonly a: Node; readonly b: Node }
  | { readonly op: "neg"; readonly a: Node }
  | { readonly op: "min" | "max" | "floor" | "ceil" | "pow"; readonly args: readonly Node[] };

const FUNCTIONS = { min: 2, max: 2, floor: 1, ceil: 1, pow: 2 } as const;

/** This count is the largest exponent that `pow` takes. A larger one is a mistake in a document, not a timer. */
const POW_LIMIT = 4096n;

/**
 * This function gives a value to a whole power: `pow(a, n)`. The exponent must be an exact whole
 * number, for example the `fired` of a backoff. A negative exponent gives the reciprocal. No bound
 * to the power 0 is 1, and to a positive power it keeps its sign when the power is odd.
 */
const power = (a: Value, b: Value): Value => {
  if (b.kind !== "exact" || !r.isInteger(b.n)) return unknown("pow takes a whole exponent");
  const k = b.n.n;
  if (k > POW_LIMIT || k < -POW_LIMIT) return unknown(`pow takes an exponent of ${POW_LIMIT} or less`);
  if (a.kind === "infinite") {
    if (k === 0n) return exact(r.ONE);
    if (k < 0n) return exact(r.ZERO);
    return k % 2n === 0n ? INFINITE : a;
  }
  if (a.kind !== "exact") return unknown("not an amount");
  if (k < 0n && a.n.n === 0n) return unknown("a division by zero");
  return exact(r.pow(a.n, Number(k)));
};

/** This function parses the arithmetic of a document, or it throws an error that tells where the text stops making sense. */
export const parseExpr = (text: string): Node => {
  const tokens = text.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.]*|[-+*/(),]|\S/g) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`"${text}": expected ${expected ?? "more"} at ${token ?? "the end"}`);
    }
    at += 1;
    return token;
  };
  const expr = (): Node => {
    let node = term();
    while (peek() === "+" || peek() === "-") {
      const op = take() as "+" | "-";
      node = { op, a: node, b: term() };
    }
    return node;
  };
  const term = (): Node => {
    let node = factor();
    while (peek() === "*" || peek() === "/") {
      const op = take() as "*" | "/";
      node = { op, a: node, b: factor() };
    }
    return node;
  };
  const factor = (): Node => {
    const token = take();
    if (token === "(") {
      const inner = expr();
      take(")");
      return inner;
    }
    if (token === "-") return { op: "neg", a: factor() };
    if (/^\d/.test(token)) return { op: "num", n: r.fromDecimal(token) };
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`"${text}": ${token} is not a term`);
    if (token in FUNCTIONS) {
      const name = token as keyof typeof FUNCTIONS;
      take("(");
      const args = [expr()];
      while (peek() === ",") {
        take(",");
        args.push(expr());
      }
      take(")");
      if (args.length !== FUNCTIONS[name]) {
        throw new Error(`"${text}": ${name} takes ${FUNCTIONS[name]}, not ${args.length}`);
      }
      return { op: name, args };
    }
    return { op: "knob", name: token };
  };
  const node = expr();
  if (at < tokens.length) throw new Error(`"${text}": ${tokens[at]} after the end`);
  return node;
};

const run = (node: Node, valueOf: (name: string) => Value): Value => {
  if (node.op === "num") return exact(node.n);
  if (node.op === "knob") return valueOf(node.name);
  if (node.op === "neg") {
    const a = run(node.a, valueOf);
    return a.kind === "exact" ? exact(r.neg(a.n)) : a.kind === "infinite" ? unboundedOf(-signOf(a)) : a;
  }
  if ("args" in node) {
    const args = node.args.map((arg) => run(arg, valueOf));
    const lost = unknownOf(args);
    if (lost !== undefined) return lost;
    if (node.op === "floor" || node.op === "ceil") {
      const [a] = args as [Value];
      return a.kind === "exact" ? exact(node.op === "floor" ? r.floor(a.n) : r.ceil(a.n)) : a;
    }
    const [a, b] = args as [Value, Value];
    if (node.op === "pow") return power(a, b);
    if (a.kind === "infinite" || b.kind === "infinite") {
      // +∞ wins a max and loses a min, and −∞ loses a max and wins a min
      const above = (x: Value, y: Value): boolean =>
        x.kind === "infinite" ? signOf(x) > 0 || (y.kind === "infinite" && signOf(y) < 0) : signOf(y) < 0;
      const larger = above(a, b) ? a : b;
      const smaller = larger === a ? b : a;
      return node.op === "max" ? larger : smaller;
    }
    if (a.kind !== "exact" || b.kind !== "exact") return unknown("not an amount");
    const aFirst = r.cmp(a.n, b.n) <= 0;
    if (node.op === "min") return aFirst ? a : b;
    return aFirst ? b : a;
  }
  const a = run(node.a, valueOf);
  const b = run(node.b, valueOf);
  const lost = unknownOf([a, b]);
  if (lost !== undefined) return lost;
  if (a.kind === "exact" && b.kind === "exact") {
    if (node.op === "/" && b.n.n === 0n) return unknown("a division by zero");
    const op = { "+": r.add, "-": r.sub, "*": r.mul, "/": r.div }[node.op];
    return exact(op(a.n, b.n));
  }
  // a timer that nothing sets is longer than each sum, and each positive multiple. Its sign
  // follows the arithmetic: cap − ∞ is −∞, which a max then discards
  if (node.op === "+" || node.op === "-") {
    const sa = signOf(a);
    const sb = node.op === "-" ? -signOf(b) : signOf(b);
    if (a.kind === "infinite" && b.kind === "infinite" && sa !== sb)
      return unknown("no bound less no bound");
    return unboundedOf(a.kind === "infinite" ? sa : sb);
  }
  if (node.op === "*") {
    const sign = signOf(a) * signOf(b);
    return sign === 0 ? unknown("zero times no bound") : unboundedOf(sign);
  }
  if (a.kind === "infinite" && b.kind === "infinite") return unknown("no bound over no bound");
  if (b.kind === "infinite") return exact(r.ZERO);
  const sign = signOf(a) * signOf(b);
  return sign === 0 ? unknown("no bound over zero") : unboundedOf(sign);
};

// ---------------------------------------------------------------------------------------------
// the named models: the formula of an implementation over its knobs, in seconds
// ---------------------------------------------------------------------------------------------

const integer = (value: Rational, what: string): bigint => {
  if (!r.isInteger(value) || value.n < 0n)
    throw new Error(`${what} is not a whole count: ${r.toNumber(value)}`);
  return value.n;
};
/** This function gives min(base × 2^k, cap), exactly. */
const capped = (base: Rational, k: bigint, cap: Rational): Rational => {
  const doubled = r.mul(base, whole(2n ** k));
  return r.cmp(doubled, cap) <= 0 ? doubled : cap;
};
/**
 * This function gives the hypothetical retransmission timeout of the kernel, tcp_model_timeout in
 * net/ipv4/tcp_timer.c. The waits double from the minimum RTO until a step is more than the
 * maximum, and then the waits are capped. For tcp_retries2 = 15, it is 0.2 s × (2^10 − 1) +
 * 6 × 120 s = 924.6 s.
 */
const retransBudget = (retries: bigint, min: Rational, max: Rational): Rational => {
  let thresh = 0n;
  while (r.cmp(r.mul(min, whole(2n ** (thresh + 1n))), max) <= 0) thresh += 1n;
  if (retries <= thresh) return r.mul(min, whole(2n ** (retries + 1n) - 1n));
  return r.add(r.mul(min, whole(2n ** (thresh + 1n) - 1n)), r.mul(whole(retries - thresh), max));
};

/** These are TCP_TIMEOUT_INIT and TCP_RTO_MAX in include/net/tcp.h at v6.6: the first SYN RTO and the cap. */
const TCP_TIMEOUT_INIT = whole(1n);
const TCP_RTO_MAX = whole(120n);

/** This function gives the whole jiffies of a time at HZ, rounded up, as msecs_to_jiffies and usecs_to_jiffies round. */
const jiffiesOf = (seconds: Rational, hz: Rational): bigint => r.ceil(r.mul(seconds, hz)).n;

/**
 * This function gives how late the timer wheel can fire a timer that is due in `jiffies`
 * (calc_wheel_index in kernel/time/timer.c at v6.6). Level 0 holds the timers due in 63 jiffies
 * or less. Each level above holds eight times as long, at eight times the granularity. The wheel
 * rounds a timer up to the next boundary of its level, thus it fires up to one granularity late.
 * At HZ 250, a 2 h timer can be up to 131 s late.
 */
const granularity = (jiffies: bigint): bigint => {
  let level = 0n;
  while (level < 8n && jiffies >= 63n << (3n * level)) level += 1n;
  return 8n ** level;
};

/**
 * This function gives the lateness of the retransmission give-up after its budget. The first
 * retransmission sets the RTO to the round trip plus the minimum, rounded up to a jiffy
 * (tcp_set_rto). On a Docker network at HZ 250, that is 204 ms, not 200.
 *
 * Each firing doubles the RTO, up to the cap. The budget ends in the firing after the last one
 * that is short of it. Thus the give-up comes one step late at most, plus the rounding of each
 * firing on the wheel. The model assumes a steady path, whose variance stays below the minimum RTO.
 */
const retransLateness = (
  retries: bigint,
  min: Rational,
  max: Rational,
  rtt: Rational,
  hz: Rational,
): Rational => {
  const base = jiffiesOf(r.add(min, rtt), hz);
  const cap = jiffiesOf(max, hz);
  let step = base;
  let wheel = 0n;
  for (let k = 1n; k <= retries + 1n; k += 1n) {
    step = base * 2n ** k < cap ? base * 2n ** k : cap;
    wheel += granularity(step);
  }
  return r.div(whole(step + wheel), hz);
};

/**
 * This function gives one wait of the retransmission timer with one segment in flight, in jiffies
 * (net/ipv4/tcp_timer.c, and tcp_schedule_loss_probe in tcp_output.c, at v6.6). Its first firing
 * is the tail loss probe. For one segment, the probe waits two round trips plus TCP_RTO_MIN, but
 * not longer than the RTO. Thus it waits the RTO itself: the round trip plus the minimum, in whole
 * jiffies.
 *
 * The probe arms the RTO again, and each RTO firing doubles it, up to the cap. Thus the
 * firing k comes 2^k RTOs after the send: 0.204, 0.408, 0.816 s on a Docker network at HZ 250.
 * With more than one segment in flight, the probe waits two round trips plus 2 jiffies.
 */
const rtoWait = (fired: bigint, min: Rational, max: Rational, rtt: Rational, hz: Rational) => {
  const base = jiffiesOf(r.add(min, rtt), hz);
  const cap = jiffiesOf(max, hz);
  if (fired === 0n) return base;
  const doubled = base * 2n ** (fired - 1n);
  return doubled < cap ? doubled : cap;
};

/**
 * This function gives the lateness of keepalive. It adds the idle timer and the interval of each
 * probe, each rounded up on the wheel at its own level. Linux arms the idle timer, then one probe
 * interval for each probe without an answer.
 */
/**
 * This function gives the lateness of the retransmission give-up after its budget, under an ICMP
 * host or net unreachable for each RTO retransmission. Each ICMP reverts one doubling of the backoff
 * (tcp_ld_RTO_revert in net/ipv4/tcp_ipv4.c at v6.6, RFC 6069). Then each wait after the first RTO
 * firing is one RTO again, thus the give-up comes at most one RTO after the budget. Each firing up
 * to it can fire up to the granularity of its level of the wheel late.
 */
const retransLatenessReverted = (
  retries: bigint,
  min: Rational,
  max: Rational,
  rtt: Rational,
  hz: Rational,
): Rational => {
  const base = jiffiesOf(r.add(min, rtt), hz);
  const budget = jiffiesOf(retransBudget(retries, min, max), hz);
  const firings = (budget + base - 1n) / base + 1n;
  return r.div(whole(base + firings * granularity(base)), hz);
};

const keepaliveLateness = (
  idle: Rational,
  interval: Rational,
  probes: bigint,
  hz: Rational,
): Rational => {
  const late = (time: Rational) => whole(granularity(jiffiesOf(time, hz)));
  return r.div(r.add(late(idle), r.mul(whole(probes), late(interval))), hz);
};

interface Model {
  /** These are the knobs that it reads, in sequence, and the unit to read each in (null for a count). */
  readonly knobs: readonly (string | null)[];
  /** This function gives the result in seconds. */
  readonly seconds: (args: readonly Rational[]) => Rational;
  readonly source: string;
}

const MODELS: Readonly<Record<string, Model>> = {
  "linux.retrans-budget": {
    knobs: [null, "s", "s"],
    seconds: ([retries, min, max]) => retransBudget(integer(retries!, "tcp_retries2"), min!, max!),
    source: "net/ipv4/tcp_timer.c tcp_model_timeout at v6.6",
  },
  // the give-up comes at the first RTO firing at the budget or after it: one step later at most,
  // at the real RTO of the path, plus the rounding of each firing on the wheel
  "linux.retrans-step": {
    knobs: [null, "s", "s", "s", "Hz"],
    seconds: ([retries, min, max, rtt, hz]) =>
      retransLateness(integer(retries!, "tcp_retries2"), min!, max!, rtt!, hz!),
    source:
      "net/ipv4/tcp_timer.c, tcp_input.c tcp_set_rto and kernel/time/timer.c at v6.6 (measured by @mark1russell7/harness, 2026-10-08)",
  },
  // one wait of the retransmission timer, the first of the loss probe: 2^(fired − 1) RTOs after it
  "linux.rto-wait": {
    knobs: [null, "s", "s", "s", "Hz"],
    seconds: ([fired, min, max, rtt, hz]) =>
      r.div(whole(rtoWait(integer(fired!, FIRED), min!, max!, rtt!, hz!)), hz!),
    source:
      "net/ipv4/tcp_timer.c tcp_retransmit_timer and tcp_output.c tcp_schedule_loss_probe at v6.6 (measured by @mark1russell7/harness, 2026-10-12)",
  },
  // one wait of the retransmission timer when each RTO retransmission draws an ICMP host or net
  // unreachable: the revert of RFC 6069 takes back the doubling, thus each wait is one RTO
  "linux.rto-wait-reverted": {
    knobs: [null, "s", "s", "s", "Hz"],
    seconds: ([, min, , rtt, hz]) => r.div(whole(jiffiesOf(r.add(min!, rtt!), hz!)), hz!),
    source: "net/ipv4/tcp_ipv4.c tcp_v4_err and tcp_ld_RTO_revert at v6.6 (RFC 6069)",
  },
  // the give-up under that revert: at most one RTO after its budget, plus the rounding of each firing
  "linux.retrans-step-reverted": {
    knobs: [null, "s", "s", "s", "Hz"],
    seconds: ([retries, min, max, rtt, hz]) =>
      retransLatenessReverted(integer(retries!, "tcp_retries2"), min!, max!, rtt!, hz!),
    source:
      "net/ipv4/tcp_ipv4.c tcp_ld_RTO_revert and net/ipv4/tcp_timer.c retransmits_timed_out at v6.6 (RFC 6069)",
  },
  // the rounding of that wait on the timer wheel, at the level that its length puts it in
  "linux.rto-wait-lateness": {
    knobs: [null, "s", "s", "s", "Hz"],
    seconds: ([fired, min, max, rtt, hz]) =>
      r.div(whole(granularity(rtoWait(integer(fired!, FIRED), min!, max!, rtt!, hz!))), hz!),
    source: "kernel/time/timer.c calc_wheel_index at v6.6",
  },
  // the idle timer of keepalive and the interval of each probe, each rounded on the wheel
  "linux.keepalive-lateness": {
    knobs: ["s", "s", null, "Hz"],
    seconds: ([idle, interval, probes, hz]) =>
      keepaliveLateness(idle!, interval!, integer(probes!, "keepcnt"), hz!),
    source: "net/ipv4/tcp_timer.c tcp_keepalive_timer and kernel/time/timer.c at v6.6",
  },
  // the rounding of one firing on the wheel: how late one timer due after this time can fire
  "linux.wheel": {
    knobs: ["s", "Hz"],
    seconds: ([time, hz]) => r.div(whole(granularity(jiffiesOf(time!, hz!))), hz!),
    source: "kernel/time/timer.c calc_wheel_index at v6.6",
  },
  // one jiffy: a timer counts from the tick before the event that arms it
  "linux.jiffy": {
    knobs: ["Hz"],
    seconds: ([hz]) => r.div(whole(1n), hz!),
    source: "include/linux/jiffies.h",
  },
  // 6.5 and later: the first tcp_syn_linear_timeouts retransmissions wait the initial RTO, the
  // others double it, and the SYN gives up after syn_retries + linear_timeouts retransmissions
  "linux.syn-giveup": {
    knobs: [null, null],
    seconds: ([retries, linear]) => {
      const n = integer(retries!, "tcp_syn_retries");
      let total = r.mul(whole(integer(linear!, "tcp_syn_linear_timeouts") + 1n), TCP_TIMEOUT_INIT);
      for (let i = 1n; i <= n; i += 1n)
        total = r.add(total, capped(TCP_TIMEOUT_INIT, i, TCP_RTO_MAX));
      return total;
    },
    source:
      "net/ipv4/tcp_timer.c tcp_write_timeout and Documentation/networking/ip-sysctl.rst at v6.6",
  },
  // the default retryStrategy of ioredis 6: min(2^(times - 1) × 50, 5000) ms, plus a jitter of up
  // to 199 ms, which the lateness of the timer carries. Its times counts attempts from 1 after the
  // last ready, thus it is one more than the number of firings of the timer. 5.x waited
  // min(times × 50, 2000) ms
  "ioredis.retry-base": {
    knobs: [null],
    seconds: ([fired]) => capped(r.fromDecimal("0.05"), integer(fired!, FIRED), whole(5n)),
    source:
      "ioredis 6.0.0 built/redis/RedisOptions.js retryStrategy and built/redis/event_handler.js",
  },
};

// ---------------------------------------------------------------------------------------------
// the evaluation of a duration and a timer
// ---------------------------------------------------------------------------------------------

/**
 * This function gives the value of a knob in the unit that the document gives it (or as a count
 * when it is a count). For `fired`, it gives which wait of a backoff timer it is.
 */
const knobIn = (
  doc: Machine,
  name: string,
  unit: string | null,
  values: KnobValues,
  fired: number | undefined,
): Value => {
  if (name === FIRED)
    return fired === undefined
      ? unknown("one wait of a timer with a backoff: say which, by how many times it has fired")
      : exact(r.fromNumber(fired));
  if (doc.knobs[name] === undefined) return unknown(`the machine names no knob ${name}`);
  const given = values(name);
  if (given === undefined) return unknown(`nothing gives ${name}'s value`);
  if ("unknown" in given) return unknown(`${name}: ${given.unknown}`);
  if (given.value === "infinite") return INFINITE;
  const value = r.fromNumber(given.value);
  return exact(
    unit === null
      ? convertExact(value, given.unit, given.unit)
      : convertExact(value, given.unit, unit),
  );
};

const out = (value: Value, unit: string): Extent | Unknown =>
  value.kind === "exact"
    ? quantity(r.toNumber(value.n), unit)
    : value.kind === "infinite"
      ? value.negative === true
        ? { unknown: "a negative unbounded time", unit }
        : unbounded(unit)
      : { unknown: value.why, unit };

/**
 * This function evaluates one duration of a timer of a machine, in the unit that its document
 * gives it. The waits of a backoff timer read `fired`, which tells which wait.
 */
export const evaluate = (
  doc: Machine,
  expr: Expr,
  values: KnobValues,
  fired?: number,
): Extent | Unknown => {
  if ("const" in expr) return quantity(expr.const, expr.unit);
  if ("knob" in expr) {
    return out(knobIn(doc, expr.knob, expr.unit, values, fired), expr.unit);
  }
  if ("expr" in expr) {
    const tree = parseExpr(expr.expr);
    const value = run(tree, (name) =>
      knobIn(doc, name, doc.knobs[name]?.unit ?? null, values, fired),
    );
    return out(value, expr.unit);
  }
  const model = MODELS[expr.model];
  if (model === undefined) return { unknown: `no model ${expr.model}`, unit: expr.unit };
  if (model.knobs.length !== expr.knobs.length) {
    return {
      unknown: `${expr.model} reads ${model.knobs.length} knobs, not ${expr.knobs.length}`,
      unit: expr.unit,
    };
  }
  const args = expr.knobs.map((name, index) =>
    knobIn(doc, name, model.knobs[index] ?? null, values, fired),
  );
  const lost = unknownOf(args);
  if (lost !== undefined) return out(lost, expr.unit);
  if (args.some((arg) => arg.kind === "infinite")) return unbounded(expr.unit);
  const seconds = model.seconds(args.map((arg) => (arg as { n: Rational }).n));
  return quantity(r.toNumber(convertExact(seconds, "s", expr.unit)), expr.unit);
};

/**
 * This function gives the bounds of a timer of a machine: how long it operates, how late it can
 * fire, how early. For a backoff timer, it gives one of its waits: the wait after `fired` firings.
 */
export const timerOf = (
  doc: Machine,
  timer: string,
  values: KnobValues,
  fired?: number,
): TimerBounds => {
  const def = doc.timers[timer];
  if (def === undefined) throw new Error(`${doc.title} has no timer ${timer}`);
  return {
    duration: evaluate(doc, def.duration, values, fired),
    ...(def.lateness !== undefined ? { lateness: evaluate(doc, def.lateness, values, fired) } : {}),
    ...(def.early !== undefined ? { early: evaluate(doc, def.early, values, fired) } : {}),
  };
};

/** A firing is one firing of a backoff timer, after `fired` firings: its time from the arming. */
export interface Firing {
  readonly fired: number;
  /** This time is the sum of the waits to this firing, each less how early it can fire. */
  readonly low: Quantity;
  /** This time is the sum of the waits to this firing, each plus how late it can fire. */
  readonly high: Quantity;
}

/** A recovery tells when the firings of a backoff timer move a connection again after a stall. */
export interface Recovery {
  /** These are its firings from its arming, up to the first one that surely comes after the end of the stall. */
  readonly firings: readonly Firing[];
  /**
   * These are the firings that can be the first after the end of the stall. There is more than one
   * when the end falls in the bounds of a firing: that firing can come before the end or after it.
   */
  readonly first: readonly number[];
  /** This time is the earliest time of the first firing after the end of the stall, from the arming. */
  readonly low: Quantity;
  /** This time is the latest time of that firing, from the arming. */
  readonly high: Quantity;
}

/** This count is the most firings that `recovery` examines before it tells that the stall is longer than them. */
const FIRINGS = 4096;

/**
 * This function gives the recovery from a stall. A backoff timer continues to fire through a
 * stall, and what each firing sends gets through only after the stall ends. Thus the connection
 * moves again at the first firing at the end or after it. That firing can be most of a wait after
 * the end. A stall that stops immediately after one firing costs almost all of the next, longer
 * wait.
 *
 * The stall counts from the arming of the timer, which is the send that the stall first lost. The
 * waits add, and so do how early and how late each can fire.
 */
export const recovery = (
  doc: Machine,
  timer: string,
  values: KnobValues,
  stall: Extent,
): Recovery | Unknown => {
  const def = doc.timers[timer];
  if (def === undefined) throw new Error(`${doc.title} has no timer ${timer}`);
  if (def.backoff === undefined) throw new Error(`${doc.title}'s ${timer} has no backoff`);
  if (isUnbounded(stall))
    return { unknown: "a stall that never ends: nothing recovers from it", unit: "s" };
  const end = convertExact(r.fromNumber(stall.value), stall.unit, "s");
  const inSeconds = (extent: Extent | Unknown | undefined, what: string): Rational | string => {
    if (extent === undefined) return r.ZERO;
    if ("unknown" in extent) return `${what}: ${extent.unknown}`;
    if (isUnbounded(extent)) return `${what} has no bound, so the timer never fires again`;
    return convertExact(r.fromNumber(extent.value), extent.unit, "s");
  };
  const s = (value: Rational): Quantity => quantity(r.toNumber(value), "s");
  const sums: Array<{ fired: number; low: Rational; high: Rational }> = [];
  let low = r.ZERO;
  let high = r.ZERO;
  for (let fired = 0; fired < FIRINGS; fired += 1) {
    const bounds = timerOf(doc, timer, values, fired);
    const wait = inSeconds(bounds.duration, `wait ${fired}`);
    const early = inSeconds(bounds.early, `wait ${fired}'s early bound`);
    const late = inSeconds(bounds.lateness, `wait ${fired}'s lateness`);
    if (typeof wait === "string") return { unknown: wait, unit: "s" };
    if (typeof early === "string") return { unknown: early, unit: "s" };
    if (typeof late === "string") return { unknown: late, unit: "s" };
    low = r.add(low, r.sub(wait, early));
    high = r.add(high, r.add(wait, late));
    sums.push({ fired, low, high });
    if (r.cmp(low, end) < 0) continue;
    // a firing whose latest time is at the end or after it can be the first after the end
    const first = sums.filter((f) => r.cmp(f.high, end) >= 0);
    const earliest = first[0]!.low;
    return {
      firings: sums.map((f) => ({ fired: f.fired, low: s(f.low), high: s(f.high) })),
      first: first.map((f) => f.fired),
      low: s(r.cmp(earliest, end) >= 0 ? earliest : end),
      high: s(first.at(-1)!.high),
    };
  }
  return { unknown: `${FIRINGS} firings do not outlast the stall`, unit: "s" };
};

/**
 * This function gives how long a mechanism takes where a machine operates, from the realization
 * of its document. The realization is one of its timers, whole, or its own duration, lateness and
 * early bound over the knobs of the machine. It gives undefined when the document does not realize the mechanism.
 */
export const realizationOf = (
  doc: Machine,
  mechanism: string,
  values: KnobValues,
): TimerBounds | undefined => {
  const how = doc.realizes?.[mechanism];
  if (how === undefined) return undefined;
  if ("timer" in how) return timerOf(doc, how.timer, values);
  return {
    duration: evaluate(doc, how.duration, values),
    ...(how.lateness !== undefined ? { lateness: evaluate(doc, how.lateness, values) } : {}),
    ...(how.early !== undefined ? { early: evaluate(doc, how.early, values) } : {}),
  };
};

/** This function gives the knobs that a realization reads, by the names of the machine for them. */
export const realizationKnobs = (doc: Machine, mechanism: string): string[] => {
  const how = doc.realizes?.[mechanism];
  if (how === undefined) return [];
  const def = "timer" in how ? doc.timers[how.timer] : how;
  if (def === undefined) return [];
  return [
    ...new Set(
      [def.duration, def.lateness, def.early].flatMap((e) => (e === undefined ? [] : exprKnobs(e))),
    ),
  ];
};

/** This function gives what in a document the algebra cannot read: arithmetic that does not parse, or a model that it does not have. */
export const algebraProblems = (doc: Machine): string[] => {
  const problems: string[] = [];
  const read = (where: string, exprs: ReadonlyArray<Expr | undefined>) => {
    for (const expr of exprs) {
      if (expr === undefined) continue;
      if ("expr" in expr) {
        try {
          parseExpr(expr.expr);
        } catch (error) {
          problems.push(`${where}: ${(error as Error).message}`);
        }
      }
      if ("model" in expr && MODELS[expr.model] === undefined)
        problems.push(`${where}: no model ${expr.model}`);
    }
  };
  for (const [id, def] of Object.entries(doc.timers)) {
    read(`timer ${id}`, [def.duration, def.lateness, def.early]);
  }
  for (const [mechanism, how] of Object.entries(doc.realizes ?? {})) {
    if (!("timer" in how)) read(`realizes ${mechanism}`, [how.duration, how.lateness, how.early]);
  }
  for (const [lower, set] of Object.entries(doc.over?.sets ?? {}))
    read(`over sets ${lower}`, [set]);
  return problems;
};

/** This function gives the source of the formula of a named model, for a reader of a result. */
export const modelSource = (name: string): string | undefined => MODELS[name]?.source;

// ---------------------------------------------------------------------------------------------
// detection: the minimum over the detectors that are live in what the connection was doing
// ---------------------------------------------------------------------------------------------

/**
 * A manifestation is what a failure lets back to the machine: the incoming events that continue
 * to arrive while it lasts. A black hole lets nothing back. The kernel of a frozen process
 * continues to acknowledge what it gets and to answer keepalive probes, thus its ACKs continue to
 * arrive.
 */
export interface Manifestation {
  readonly name: string;
  readonly passes: readonly string[];
  /**
   * These are the events that the failure itself sends one time, for example the FIN of a process
   * that stopped with SIGKILL. A delivered event that a transition takes from the state of the connection detects the
   * failure at once.
   */
  readonly delivers?: readonly string[] | undefined;
  /**
   * This errno replaces ETIMEDOUT when one of these timers gives up. Linux keeps an ICMP error on
   * an established socket as a soft error, and the timeout reports it (tcp_write_err). An ICMP
   * counts only when it quotes a segment in the window (tcp_v4_err). A retransmission is in the
   * window. A keepalive probe uses the sequence number before snd_una, thus its ICMP does not count.
   */
  readonly errno?: { readonly errno: string; readonly timers: readonly string[] } | undefined;
  /**
   * These are the durations that the failure changes, by timer. For example, an ICMP host
   * unreachable for each retransmission reverts the backoff of the retransmission timer.
   */
  readonly replaces?:
    | Readonly<
        Record<string, { readonly duration?: Expr; readonly lateness?: Expr; readonly early?: Expr }>
      >
    | undefined;
}

/** A situation is the activity of the connection when the failure started. */
export interface Situation {
  /** This name is the state of the machine, for example ESTABLISHED. */
  readonly state: string;
  /** This flag tells if it had sent data that the peer had not acknowledged. */
  readonly inFlight: boolean;
}

/** A detector is a timer that can still fire, how long it operates, and the event that it fires. */
export interface Detector {
  readonly timer: string;
  readonly fires: string;
  readonly duration: Extent | Unknown;
  /** This identifier is the machine below whose timer it is, when the timer is not of the machine itself (`over`). */
  readonly beneath?: string | undefined;
}

/** A detection is the result of the minimum over the live detectors. */
export interface Detection {
  /** These are the timers that can still fire, the soonest first. */
  readonly detectors: readonly Detector[];
  /** This detector is the first to fire, or null when none can fire in a known time: a silent failure. */
  readonly first: Detector | null;
  /** These are the live detectors whose time nothing gives. Then `first` is only an upper bound. */
  readonly unsettled: readonly string[];
  /** These are the timers that are armed but cannot fire, and the reason for each. */
  readonly held: ReadonlyArray<{ readonly timer: string; readonly why: string }>;
  /**
   * These are the events that the failure delivers and that a transition takes from the state:
   * each detects the failure at once, before any timer. The errno is the errno of the transition,
   * or null for an end of file.
   */
  readonly delivered: ReadonlyArray<{
    readonly event: string;
    readonly to: string;
    readonly errno: string | null;
  }>;
}

const soonest = (a: Detector, b: Detector): number => {
  const rank = (d: Detector): number =>
    "unknown" in d.duration ? 2 : d.duration.value === "infinite" ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) !== 0) return a.timer.localeCompare(b.timer);
  const seconds = (d: Detector) => {
    const value = d.duration as Extent & { value: number };
    return r.toNumber(convertExact(r.fromNumber(value.value), value.unit, "s"));
  };
  return seconds(a) - seconds(b) || a.timer.localeCompare(b.timer);
};

/**
 * This function gives the detection: the minimum over the detectors that are live in the
 * situation. The entry to the state arms a timer, and so does what the failure causes: data in
 * flight without an acknowledgment gets a retransmission. An event that occurs cancels a timer.
 *
 * An event that arms the timer again, and that the failure continues to let through, stops it
 * before it fires. For example, the kernel of a frozen process answers each keepalive probe.
 * Without a live detector, the failure is silent at the level of this machine. Only something
 * above it, the timeout of an application or a heartbeat, can find it. The result is only as good
 * as the events that the document names.
 */
export const detection = (
  doc: Machine,
  situation: Situation,
  manifestation: Manifestation,
  values: KnobValues,
): Detection => {
  const passes = new Set(manifestation.passes);
  const happened = new Set([`enter:${situation.state}`]);
  if (situation.inFlight && !passes.has("rx.ack")) happened.add("tx.retransmit.first");
  const occurs = (event: string): boolean => happened.has(event) || passes.has(event);
  const detectors: Detector[] = [];
  const held: Array<{ timer: string; why: string }> = [];
  for (const [timer, def] of Object.entries(doc.timers)) {
    // a backoff timer starts again when it fires: its firing is a new try of the machine, and
    // another timer gives up on it, as the retransmission give-up does
    if (def.backoff !== undefined) continue;
    if (!def.arms.some(occurs)) continue;
    const cancelled = (def.cancels ?? []).find(occurs);
    if (cancelled !== undefined) {
      held.push({ timer, why: `${cancelled} cancels it` });
      continue;
    }
    const rearmed = def.arms.find((event) => passes.has(event));
    if (rearmed !== undefined) {
      held.push({ timer, why: `${rearmed} keeps arriving and re-arms it` });
      continue;
    }
    const duration = manifestation.replaces?.[timer]?.duration ?? def.duration;
    detectors.push({ timer, fires: def.fires, duration: evaluate(doc, duration, values) });
  }
  detectors.sort(soonest);
  const [earliest] = detectors;
  const finite =
    earliest !== undefined &&
    !("unknown" in earliest.duration) &&
    earliest.duration.value !== "infinite";
  const delivered = (manifestation.delivers ?? []).flatMap((event) => {
    const taken = transitionOn(doc, situation.state, event);
    return taken === undefined ? [] : [{ event, to: taken.to, errno: taken.errno ?? null }];
  });
  return {
    detectors,
    first: finite ? earliest : null,
    unsettled: detectors.filter((d) => "unknown" in d.duration).map((d) => d.timer),
    held,
    delivered,
  };
};

/**
 * This function gives the bounds of a timer of a machine under a failure: its own bounds, with each
 * duration that the manifestation replaces.
 */
export const timerUnder = (
  doc: Machine,
  timer: string,
  values: KnobValues,
  manifestation: Manifestation,
  fired?: number,
): TimerBounds => {
  const def = doc.timers[timer];
  if (def === undefined) throw new Error(`${doc.title} has no timer ${timer}`);
  const replaced = manifestation.replaces?.[timer];
  const duration = replaced?.duration ?? def.duration;
  const lateness = replaced?.lateness ?? def.lateness;
  const early = replaced?.early ?? def.early;
  return {
    duration: evaluate(doc, duration, values, fired),
    ...(lateness !== undefined ? { lateness: evaluate(doc, lateness, values, fired) } : {}),
    ...(early !== undefined ? { early: evaluate(doc, early, values, fired) } : {}),
  };
};

/**
 * This function gives the errno of a detection by a timer: the errno of the transition that its
 * event takes from the state. A soft error of the manifestation replaces ETIMEDOUT, but only for
 * the timers whose segments its ICMP quotes in the window.
 */
export const errnoOf = (
  doc: Machine,
  state: string,
  detector: { readonly timer: string; readonly fires: string },
  manifestation: Manifestation,
): string | null => {
  const errno = transitionOn(doc, state, detector.fires)?.errno ?? null;
  const soft = manifestation.errno;
  return errno === "ETIMEDOUT" && soft !== undefined && soft.timers.includes(detector.timer)
    ? soft.errno
    : errno;
};

// ---------------------------------------------------------------------------------------------
// a machine on another machine: a driver on its kernel socket
// ---------------------------------------------------------------------------------------------

/** This function gives the transition that a machine takes from a state on an event, by its document. */
export const transitionOn = (
  doc: Machine,
  state: string,
  event: string,
): TransitionDef | undefined =>
  doc.transitions.find((t) => fromStates(doc, t.from).includes(state) && arr(t.on).includes(event));

/**
 * This function gives the values of a machine for the machine that it operates on. These are the
 * knobs that it sets, evaluated over its own knobs, and the other knobs of the lower machine. The
 * keepAlive of ioredis at 5000 ms is the keepidle of the kernel at 5 s.
 */
export const overValues =
  (upper: Machine, upperValues: KnobValues, lowerValues: KnobValues): KnobValues =>
  (name) => {
    const set = upper.over?.sets[name];
    return set === undefined ? lowerValues(name) : evaluate(upper, set, upperValues);
  };

/**
 * This function gives the detection through the machine that a machine operates on. The detectors
 * of the lower machine are live in the state below the state of this machine. They use the knobs
 * that this machine sets.
 *
 * Each one reaches this machine as the event that the end of the lower
 * machine gives. They are beside the timers of this machine, and the first of all of them is the
 * first detection. A failure lets nothing new through to a machine above the socket, only the end
 * of the socket. Thus the timers of this machine see only what its state arms.
 */
export const stackedDetection = (
  upper: Machine,
  lower: Machine,
  situation: Situation,
  manifestation: Manifestation,
  upperValues: KnobValues,
  lowerValues: KnobValues,
): Detection => {
  const over = upper.over;
  if (over === undefined) throw new Error(`${upper.title} runs on no other machine`);
  const sitsOn = over.states[situation.state];
  if (sitsOn === undefined) {
    throw new Error(`${upper.title}'s ${situation.state} sits on no state of ${lower.title}`);
  }
  const own = detection(upper, situation, { name: manifestation.name, passes: [] }, upperValues);
  const below = detection(
    lower,
    { ...situation, state: sitsOn },
    manifestation,
    overValues(upper, upperValues, lowerValues),
  );
  const detectors = [
    ...own.detectors,
    ...below.detectors.map((d) => ({ ...d, beneath: over.machine })),
  ].sort(soonest);
  const [earliest] = detectors;
  const finite =
    earliest !== undefined &&
    !("unknown" in earliest.duration) &&
    earliest.duration.value !== "infinite";
  return {
    detectors,
    first: finite ? earliest : null,
    unsettled: detectors.filter((d) => "unknown" in d.duration).map((d) => d.timer),
    held: [...own.held, ...below.held.map((h) => ({ ...h, why: `${h.why}, beneath` }))],
    // what the failure delivers reaches the socket below: its end is the end of this machine
    delivered: below.delivered,
  };
};
