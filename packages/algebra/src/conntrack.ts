/**
 * This function gives the lowest count of one network namespace after one scan of the conntrack
 * collector under pressure. Each entry of the table can go at that scan. The sources are Linux v7.0,
 * `net/netfilter/nf_conntrack_core.c`.
 *
 * - The scan starts to drop at `nf_conntrack_max / 100 * 95`, in integer arithmetic (lines 1526-1527).
 *   It drops an entry while the count is at that value or above it (lines 1605-1608). Thus this limit
 *   stops the scan one entry below the value.
 * - A scan ends after more than `64000 / HZ` drops (line 97, lines 1561-1572). That end clears the
 *   pressure (lines 1645-1646). Thus this limit stops the scan after `64000 / HZ + 1` drops.
 *
 * The limit that stops the scan first gives the floor.
 */
export const conntrackFloor = (max: number, hz: number): number =>
  Math.max(Math.floor(max / 100) * 95 - 1, max - Math.floor(64000 / hz) - 1);
