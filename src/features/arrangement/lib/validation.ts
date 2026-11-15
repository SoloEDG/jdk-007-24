import type { Session, Track, Note, Instrument } from "@/shared/types";
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
/**
 * Validate an untrusted note list against the instrument that will play it.
 * `length` is the musical span (loop length for a session, capture length for
 * a recorder draft). Used by both session and draft validation so a recovered
 * take can never smuggle in notes outside the loop.
 */
export function validateNoteList(
  notes: unknown,
  instrument: Instrument,
  length: number,
): Note[] {
  if (!Array.isArray(notes) || notes.length > 2048)
    throw new Error("音符列表无效");
  const ids = new Set<string>();
  for (const n of notes as Note[]) {
    if (
      !object(n) ||
      typeof n.id !== "string" ||
      !n.id ||
      ids.has(n.id) ||
      !finite(
        n.pitch,
        instrument === "drums" ? 0 : 24,
        instrument === "drums" ? 3 : 108,
      ) ||
      !Number.isInteger(n.pitch) ||
      !finite(n.beat, 0, length - 0.000001) ||
      !finite(n.duration, 0.01, length) ||
      !finite(n.velocity, 0.01, 1)
    )
      throw new Error("音符数据无效");
    ids.add(n.id);
  }
  return structuredClone(notes) as Note[];
}
export function validateSession(raw: unknown): Session {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    typeof raw.title !== "string" ||
    raw.title.length > 80 ||
    !finite(raw.bpm, 40, 220) ||
    ![4, 8, 16, 32].includes(raw.beats as number) ||
    !Array.isArray(raw.tracks) ||
    raw.tracks.length > 8 ||
    !object(raw.channels) ||
    !finite(raw.master, 0, 1)
  )
    throw new Error("存档格式或版本不受支持");
  const ids = new Set<string>();
  const noteIds = new Set<string>();
  const beats = raw.beats as number;
  for (const value of raw.tracks) {
    if (!object(value)) throw new Error("轨道损坏");
    const t = value as unknown as Track;
    if (
      typeof t.id !== "string" ||
      ids.has(t.id) ||
      !t.id ||
      typeof t.name !== "string" ||
      t.name.length > 32 ||
      !["drums", "keys"].includes(t.instrument) ||
      !/^#[0-9a-f]{6}$/i.test(t.color) ||
      !Array.isArray(t.notes) ||
      t.notes.length > 2048
    )
      throw new Error("轨道数据无效");
    ids.add(t.id);
    // Reuse the shared note validator, then enforce global note-id uniqueness.
    for (const n of validateNoteList(t.notes, t.instrument, beats)) {
      if (noteIds.has(n.id)) throw new Error("音符数据无效");
      noteIds.add(n.id);
    }
    const c = raw.channels[t.id];
    if (!object(c) || !finite(c.volume, 0, 1) || typeof c.muted !== "boolean")
      throw new Error("混音数据无效");
  }
  return structuredClone(raw) as unknown as Session;
}
