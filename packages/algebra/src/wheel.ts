/**
 * This function gives how late the timer wheel can fire a timer that is due in `jiffies`
 * (`calc_wheel_index` in `kernel/time/timer.c`, the same at v6.6 and at v7.0, lines 541-562). Level
 * 0 holds the timers due in less than 63 jiffies. Each level above holds eight times as long, at
 * eight times the granularity. The wheel puts a timer on the next boundary of its level (lines
 * 524-539), thus it fires up to one granularity late. At HZ 250, a 2 h timer can be up to 131 s late.
 */
export const granularity = (jiffies: bigint): bigint => {
  let level = 0n;
  while (level < 8n && jiffies >= 63n << (3n * level)) level += 1n;
  return 8n ** level;
};
