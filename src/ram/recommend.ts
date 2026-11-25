import type { RamFrame } from './tracker';

export type RecommendationState = 'collecting' | 'ok' | 'too-big' | 'too-small';

export interface Recommendation {
  id: string;
  state: RecommendationState;
  /** Heap the server has (or will have after a restart). */
  currentMb: number;
  /** Suggested heap, once there is enough data. */
  recommendedMb: number | null;
  /** Highest heap in use after a garbage collection, and highest heap in use at all, in the window. */
  peakLiveMb: number | null;
  peakUsedMb: number | null;
  /** Memory that would be freed (too-big) or is missing (too-small). */
  deltaMb: number;
  samples: number;
  reason: string;
}

export interface RecommendOptions {
  windowMinutes?: number;
  /** Fewer running samples than this: no advice yet (at 10 s per sample, 60 = 10 minutes). */
  minSamples?: number;
  /** A garbage collector works well with the live data at about 60 % of the heap or less. */
  liveFactor?: number;
  now?: number;
}

const step = (mb: number): number => Math.ceil(mb / 64) * 64;

/**
 * Compares what each server really needs (heap still in use after garbage collections) with its heap.
 * "Too big" frees memory for others; "too small" warns before the server runs into out-of-memory
 * stutter. Nothing is changed automatically: the dashboard offers the suggestion as a button.
 */
export function recommend(frames: RamFrame[], serverIds: string[], opts: RecommendOptions = {}): Recommendation[] {
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowMinutes ?? 24 * 60) * 60_000;
  const minSamples = opts.minSamples ?? 60;
  const factor = opts.liveFactor ?? 1 / 0.6;
  const window = frames.filter((f) => f.t >= since);

  return serverIds.map((id): Recommendation => {
    const samples = window.map((f) => f.servers[id]).filter((s) => s && s.state === 'running' && s.liveSetMb !== null && s.heapUsedMb !== null);
    const last = [...window].reverse().find((f) => f.servers[id])?.servers[id];
    const currentMb = last?.maxMb ?? 0;
    const base = { id, currentMb, samples: samples.length, peakLiveMb: null as number | null, peakUsedMb: null as number | null };
    if (samples.length < minSamples) {
      return { ...base, state: 'collecting', recommendedMb: null, deltaMb: 0, reason: `Collecting data (${samples.length} of ${minSamples} measurements while running).` };
    }
    const peakLiveMb = Math.max(...samples.map((s) => s.liveSetMb as number));
    const peakUsedMb = Math.max(...samples.map((s) => s.heapUsedMb as number));
    const recommendedMb = Math.max(256, step(peakLiveMb * factor));
    const common = { ...base, peakLiveMb, peakUsedMb, recommendedMb };
    if (currentMb > 0 && peakUsedMb >= currentMb * 0.92 && peakLiveMb >= currentMb * 0.6) {
      return { ...common, state: 'too-small', deltaMb: recommendedMb - currentMb, reason: `The heap is nearly full even after garbage collection (up to ${Math.round(peakLiveMb)} MB of ${currentMb} MB stay in use).` };
    }
    if (currentMb > recommendedMb * 1.5 && currentMb - recommendedMb >= 512) {
      return { ...common, state: 'too-big', deltaMb: currentMb - recommendedMb, reason: `At most ${Math.round(peakLiveMb)} MB stay in use; ${currentMb} MB is more than needed.` };
    }
    return { ...common, state: 'ok', deltaMb: 0, reason: 'The heap fits what the server uses.' };
  });
}
