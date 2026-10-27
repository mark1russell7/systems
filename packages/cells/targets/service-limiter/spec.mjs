// The spec of the one limiter of the target, from the flags of the server. This module imports
// nothing of @mark1russell7/service. Thus the server of an older version can read it without the
// check of declaration.mjs.

const count = (value) => ({ value, unit: "count" });

/** This is the name of the one limiter of the target. */
export const LIMITER = "calls";

/**
 * This function gives the spec of the limiter from the flags of the server. A token bucket has its
 * rate in count/s. A sliding window has its window in ms. Each request has its key in the header
 * x-limiter-key.
 */
export const specOf = ({ policy, limit, windowMs, ratePerS, burst, maxKeys }) => ({
  key: "x-limiter-key",
  policy:
    policy === "token-bucket"
      ? { type: "token-bucket", rate: { value: ratePerS, unit: "count/s" }, burst: count(burst) }
      : { type: "sliding-window", limit: count(limit), window: { value: windowMs, unit: "ms" } },
  store: { kind: "local" },
  evict: { maxKeys: count(maxKeys) },
});
