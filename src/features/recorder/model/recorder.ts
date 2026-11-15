import type { Note, NoteInput, Instrument, RecorderDraft } from "@/shared/types";
import { captureBoundary, recordedNote } from "../lib/quantize";
const LIMIT = 2048;
export type RecorderState = {
  status: "idle" | "waiting" | "recording" | "recovered";
  trackId: string | null;
  start: number;
  length: number;
  draft: Note[];
  grid: number;
  /** Absolute musical beat up to which capture was reliably observed. */
  progress: number;
  transactionId: string;
  /** Musical beat at which a confirmed recovered take continues. */
  resumeAt: number;
};
export function createRecorder() {
  let status: RecorderState["status"] = "idle",
    trackId: string | null = null,
    instrument: Instrument = "drums",
    start = 0,
    length = 16,
    grid = 0.25,
    draft: Note[] = [],
    progress = 0,
    transactionId = "",
    resumeAt = 0;
  const held = new Map<string, { note: NoteInput; beat: number }>();
  const newTransactionId = (track: string, at: number) =>
    `take:${track}:${at}:${Date.now().toString(36)}:${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  const pushNote = (pitch: number, from: number, to: number, velocity: number) => {
    if (draft.length >= LIMIT) return;
    // A tap shorter than one tick still counts as one grid step. Requiring
    // `to > from` would silently drop very fast presses and key-ups that land
    // in the same scheduler tick as their key-down.
    const end = Math.max(from, to);
    draft.push(
      recordedNote(pitch, from - start, end - start, length, velocity, grid),
    );
  };
  /**
   * Close every held key at `at`, which is the last beat capture was reliably
   * observed. Doing this before persisting guarantees no note extends beyond
   * the saved progress, so a crash cannot leave a "half note" dangling.
   */
  const flushHeld = (at: number) => {
    const boundary = Math.max(start, Math.min(start + length, at));
    for (const id of [...held.keys()]) {
      const h = held.get(id);
      if (!h) continue;
      held.delete(id);
      pushNote(
        h.note.pitch,
        h.beat,
        Math.min(start + length, Math.max(h.beat, boundary)),
        h.note.velocity,
      );
    }
  };
  const reset = () => {
    status = "idle";
    trackId = null;
    draft = [];
    held.clear();
    progress = 0;
    transactionId = "";
    resumeAt = 0;
  };
  const finish = () => {
    flushHeld(start + length);
    progress = start + length;
    const result = {
      trackId: trackId!,
      notes: structuredClone(draft),
      transactionId,
    };
    reset();
    return result;
  };
  return {
    snapshot(): RecorderState {
      return {
        status,
        trackId,
        start,
        length,
        draft: structuredClone(draft),
        grid,
        progress,
        transactionId,
        resumeAt,
      };
    },
    grid(value: number) {
      if (status === "idle" && [0.25, 0.5, 1].includes(value)) grid = value;
    },
    arm(id: string, kind: Instrument, absolute: number, beats: number) {
      if (status !== "idle") return;
      trackId = id;
      instrument = kind;
      start = captureBoundary(absolute, beats);
      length = beats;
      draft = [];
      held.clear();
      progress = start;
      transactionId = newTransactionId(id, start);
      resumeAt = start;
      status = "waiting";
    },
    down(id: string, note: NoteInput, absolute: number) {
      // A recovered take is frozen until the user confirms it; monitoring a
      // key must not silently resume capture.
      if (
        status !== "recording" ||
        note.instrument !== instrument ||
        held.has(id) ||
        draft.length + held.size >= LIMIT
      )
        return;
      held.set(id, { note, beat: absolute });
    },
    up(id: string, absolute: number) {
      const h = held.get(id);
      if (!h) return;
      held.delete(id);
      pushNote(
        h.note.pitch,
        h.beat,
        Math.min(start + length, Math.max(h.beat, absolute)),
        h.note.velocity,
      );
    },
    advance(absolute: number) {
      // A recovered take stays frozen until the user confirms it, so the
      // transport being paused can never silently finish the capture.
      if (status === "recovered") return null;
      if (status === "waiting" && absolute >= start) {
        status = "recording";
        progress = Math.max(progress, start);
      }
      if (status === "recording") {
        progress = Math.max(progress, Math.min(absolute, start + length));
        if (absolute >= start + length) return finish();
      }
      return null;
    },
    cancel() {
      reset();
    },
    /**
     * A definitive capture boundary (pause / stop / explicit close): close
     * held keys at `absolute` and advance progress there. Unlike `freeze`,
     * this mutates live state because the note really has stopped sounding.
     */
    settle(absolute: number) {
      if (status !== "recording" && status !== "waiting") return;
      const reliable = Math.max(
        progress,
        Math.min(start + length, Math.max(start, absolute)),
      );
      flushHeld(reliable);
      if (status === "waiting" && reliable > start) status = "recording";
      progress = reliable;
    },
    /**
     * Freeze the take at the last reliable beat and return a persistable
     * description. Held keys are represented as notes ending at that beat
     * without mutating live state, so a periodic save never audibly cuts a
     * key the user is still pressing.
     */
    freeze(absolute: number): RecorderDraft | null {
      if (status === "idle" || status === "recovered" || !trackId) return null;
      const reliable = Math.max(
        progress,
        Math.min(start + length, Math.max(start, absolute)),
      );
      const notes = structuredClone(draft);
      for (const h of held.values()) {
        if (notes.length >= LIMIT) break;
        const from = Math.max(h.beat, start);
        const to = Math.min(start + length, Math.max(h.beat, reliable));
        // Same rule as live capture: a press still counts even if the freeze
        // happens in the same tick, so no note is silently dropped.
        notes.push(
          recordedNote(
            h.note.pitch,
            from - start,
            Math.max(from, to) - start,
            length,
            h.note.velocity,
            grid,
          ),
        );
      }
      return {
        status: status === "waiting" && reliable <= start ? "waiting" : "recording",
        trackId,
        instrument,
        start,
        length,
        grid,
        notes,
        progress: reliable,
        transactionId,
      };
    },
    /**
     * Re-open a frozen take paused. It is marked `recovered` and must be
     * confirmed before capture resumes, so the user can compare it with the
     * original track first.
     */
    restore(saved: RecorderDraft) {
      if (status !== "idle") return false;
      trackId = saved.trackId;
      instrument = saved.instrument;
      start = saved.start;
      length = saved.length;
      grid = saved.grid;
      draft = structuredClone(saved.notes);
      progress = saved.progress;
      transactionId = saved.transactionId;
      held.clear();
      resumeAt = Math.min(start + length, Math.max(start, saved.progress));
      status = "recovered";
      return true;
    },
    /** Confirm a recovered take; capture continues from `resumeAt`. */
    confirm() {
      if (status !== "recovered") return false;
      // `start` stays loop-aligned: recorded beats remain loop-relative and
      // the remaining capture runs to the same `start + length` boundary.
      status = "recording";
      progress = Math.max(progress, resumeAt);
      return true;
    },
    /**
     * Persistable view of the current take: freezes an in-progress capture at
     * the last reliable beat, but keeps a `recovered` take exactly as-is so a
     * second crash cannot lose the partial the user has not confirmed yet.
     */
    persistable(absolute: number): RecorderDraft | null {
      if (status === "idle" || !trackId) return null;
      if (status === "recovered") {
        return {
          status: "recovered",
          trackId,
          instrument,
          start,
          length,
          grid,
          notes: structuredClone(draft),
          progress,
          transactionId,
        };
      }
      return this.freeze(absolute);
    },
    /** Abandon a recovered partial take, keeping the original track untouched. */
    discard() {
      if (status === "recovered" || status === "idle") reset();
    },
    /** Musical position where a recovered take stopped, for display. */
    resumePosition() {
      return resumeAt;
    },
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
