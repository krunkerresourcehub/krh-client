/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/preload/hud/frame-stats.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Frame-time statistics for the performance HUD.
 *
 * A plain FPS counter hides the thing that actually matters in a shooter: 300
 * FPS with regular 40ms hitches feels far worse than a steady 200. So this
 * reports percentile lows next to the average.
 *
 * "1% low" is the usual convention, the mean of the worst 1% of frame times in
 * the window expressed as FPS, not the 99th-percentile single frame. Averaging
 * the tail jumps around less than reporting one sample.
 *
 * Fixed ring buffer behind it. This runs on every animation frame, so it can't
 * allocate per frame or the profiler turns into the problem.
 */
export interface FrameSnapshot {
  /** Mean FPS over the window. */
  readonly fps: number;
  /** Mean frame time in ms. */
  readonly frameTimeMs: number;
  /** Mean of the worst 1% of frames, as FPS. 0 until the window fills enough. */
  readonly low1: number;
  /** Mean of the worst 0.1% of frames, as FPS. */
  readonly low01: number;
  /** Samples currently held. */
  readonly samples: number;
}

const EMPTY: FrameSnapshot = { fps: 0, frameTimeMs: 0, low1: 0, low01: 0, samples: 0 };

export class FrameStats {
  private readonly buffer: Float64Array;
  private readonly scratch: Float64Array;
  private writeIndex = 0;
  private count = 0;
  private sum = 0;

  /** @param capacity Frames retained. ~1000 is a few seconds at high refresh. */
  constructor(capacity = 1000) {
    const size = Math.max(1, Math.floor(capacity));
    this.buffer = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  /** Record one frame delta in milliseconds. Non-finite or <= 0 is ignored. */
  push(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;

    // A tab-out or a breakpoint gives you a multi-second delta, which poisons
    // the average for the whole window. Anything absurd counts as a gap.
    if (deltaMs > 1000) return;

    const size = this.buffer.length;
    if (this.count === size) {
      this.sum -= this.buffer[this.writeIndex] ?? 0;
    } else {
      this.count += 1;
    }
    this.buffer[this.writeIndex] = deltaMs;
    this.sum += deltaMs;
    this.writeIndex = (this.writeIndex + 1) % size;
  }

  reset(): void {
    this.writeIndex = 0;
    this.count = 0;
    this.sum = 0;
  }

  snapshot(): FrameSnapshot {
    if (this.count === 0) return EMPTY;

    const mean = this.sum / this.count;

    // Copy into scratch and sort ascending. The tail is the slow frames.
    const view = this.scratch.subarray(0, this.count);
    view.set(this.buffer.subarray(0, this.count));
    view.sort();

    return {
      fps: mean > 0 ? 1000 / mean : 0,
      frameTimeMs: mean,
      low1: this.tailMeanFps(view, 0.01),
      low01: this.tailMeanFps(view, 0.001),
      samples: this.count,
    };
  }

  /** Mean of the slowest `fraction` of an ascending-sorted window, as FPS. */
  private tailMeanFps(sorted: Float64Array, fraction: number): number {
    const n = sorted.length;
    // Below this there aren't enough samples for the slice to mean anything
    // and the number swings wildly, so report nothing at all.
    if (n < Math.ceil(1 / fraction)) return 0;

    const take = Math.max(1, Math.floor(n * fraction));
    let total = 0;
    for (let i = n - take; i < n; i += 1) total += sorted[i] ?? 0;
    const mean = total / take;
    return mean > 0 ? 1000 / mean : 0;
  }
}
