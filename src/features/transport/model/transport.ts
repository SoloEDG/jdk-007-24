import { clamp } from "@/shared/math";
import { clockBeat, loopPosition } from "../lib/timing";
import type { TransportSnapshot } from "@/shared/types";
export function createTransport() {
  let bpm = 108,
    beats = 16,
    running = false,
    anchor = 0,
    offset = 0,
    cursor = 0;
  const absolute = (now: number) =>
    running ? clockBeat(now, anchor, offset, bpm) : offset;
  return {
    view(now: number) {
      const abs = absolute(now);
      return {
        bpm,
        beats,
        running,
        absolute: abs,
        position: loopPosition(abs, beats),
      };
    },
    /** Musical position only — audio-clock seconds are never persisted. */
    snapshot(now = 0): TransportSnapshot {
      return { bpm, beats, beat: absolute(now), running };
    },
    start(now: number) {
      if (running) return;
      // A fresh anchor is established every time the transport starts, so a
      // restored session never inherits the closed page's absolute seconds.
      anchor = now;
      cursor = offset;
      running = true;
    },
    pause(now: number) {
      offset = absolute(now);
      running = false;
      cursor = offset;
    },
    stop() {
      running = false;
      offset = 0;
      cursor = 0;
    },
    /** Move to an absolute musical beat without starting playback. */
    seek(beat: number) {
      running = false;
      offset = Math.max(0, Number.isFinite(beat) ? beat : 0);
      cursor = offset;
    },
    /**
     * Re-open a persisted position paused with a brand-new anchor. The
     * scheduler cursor is parked at the saved beat, so notes that fell inside
     * the closed period are never back-filled.
     */
    restore(state: TransportSnapshot) {
      running = false;
      bpm = clamp(Math.round(state.bpm), 40, 220);
      beats = [4, 8, 16, 32].includes(state.beats) ? state.beats : 16;
      offset = Math.max(0, Number.isFinite(state.beat) ? state.beat : 0);
      anchor = 0;
      cursor = offset;
    },
    configure(tempo: number, length: number) {
      this.stop();
      bpm = clamp(Math.round(tempo), 40, 220);
      beats = [4, 8, 16, 32].includes(length) ? length : 16;
    },
    window(now: number, ceiling = Infinity) {
      if (!running) return null;
      const abs = absolute(now);
      // Keep a short late window so a transaction committed at a loop boundary
      // can still schedule its first note; discard long background backlog.
      const from = Math.max(cursor, abs - (0.1 * bpm) / 60);
      const to = Math.min(ceiling, abs + (0.075 * bpm) / 60);
      if (to <= from) return null;
      cursor = to;
      return {
        from,
        to,
        timeAt: (beat: number) => anchor + ((beat - offset) * 60) / bpm,
      };
    },
  };
}
export type Transport = ReturnType<typeof createTransport>;
