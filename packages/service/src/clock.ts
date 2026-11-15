// @mark1russell7/service/clock: the clock of the runtime, with no other part of the package. Its
// home is @mark1russell7/algebra/clock, and this entry gives it again, thus the callers do not
// change. That entry imports nothing: no `node:` module and no zod. Thus a client in a browser can use it.

export type { Cancel, Clock, PlatformClockOptions } from "@mark1russell7/algebra/clock";
export { platformClock, realClock } from "@mark1russell7/algebra/clock";
