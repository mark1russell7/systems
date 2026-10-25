// This module has no imports: the agent of the lab image imports it as it is.

/**
 * This filter of RE2 selects the two counters of the listener manager of Envoy that an update of LDS
 * moves (`/stats?filter=`, `source/server/admin/stats_params.cc` of Envoy v1.39.4). An update of a
 * listener counts `listener_modified`. An update in place, of its filter chains only, also counts
 * `listener_in_place_updated` (`listener_manager_impl.cc:644`, `:692`).
 */
export const LDS_FILTER = "^listener_manager\\.listener_(in_place_updated|modified)$";

/** The listener counts are the two counters of LDS of one sidecar: each update (`mod`), and each update in place (`inPlace`). */
export interface ListenerCounts {
  readonly mod: number;
  readonly inPlace: number;
}

/**
 * This function gives the listener counts of the text of `/stats`, one `name: value` on each line
 * (`stats_render.cc:15`). It gives null when the text has no counter `listener_modified`.
 */
export const listenerCountsOf = (text: string): ListenerCounts | null => {
  let mod: number | null = null;
  let inPlace = 0;
  for (const line of text.split("\n")) {
    const match = /^listener_manager\.listener_(in_place_updated|modified): (\d+)$/.exec(line.trim());
    if (match === null) continue;
    if (match[1] === "modified") mod = Number(match[2]);
    else inPlace = Number(match[2]);
  }
  return mod === null ? null : { mod, inPlace };
};
