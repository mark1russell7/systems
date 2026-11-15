import { describe, expect, it } from "vitest";
import { playerStep, type PlayerAction, type PlayerState } from "./RequestPath.tsx";

const after = (state: PlayerState, actions: readonly PlayerAction[]): PlayerState => actions.reduce(playerStep, state);

describe("the player of the request path", () => {
  it("starts a new loop from 0 on a restart while it plays", () => {
    const playing: PlayerState = { progress: 0.6, playing: true, run: 3 };
    const restarted = after(playing, [{ type: "seek", progress: 0 }, { type: "play" }]);
    // The loop effect depends on `playing` and `run`. The run changed, thus the loop starts again from 0.
    expect(restarted).toEqual({ progress: 0, playing: true, run: 4 });
  });

  it("stops at the end of the timeline, and a pause or a second play changes nothing more", () => {
    const playing: PlayerState = { progress: 0.9, playing: true, run: 1 };
    expect(after(playing, [{ type: "frame", progress: 0.95 }])).toEqual({ progress: 0.95, playing: true, run: 1 });
    expect(after(playing, [{ type: "frame", progress: 1 }])).toEqual({ progress: 1, playing: false, run: 1 });
    expect(playerStep(playing, { type: "play" })).toBe(playing);
    const paused = playerStep(playing, { type: "pause" });
    expect(playerStep(paused, { type: "pause" })).toBe(paused);
  });
});
