import type {
  RecorderDraft,
  Session,
  TransportSnapshot,
} from "@/shared/types";
import { validateSession, validateNoteList } from "@/features/arrangement/lib/validation";
import { checksum } from "./checksum";
export const DRAFT_VERSION = 2;
export type DraftPayload = {
  version: typeof DRAFT_VERSION;
  revision: number;
  savedAt: number;
  /** Last committed arrangement — never a half-applied take. */
  session: Session;
  /** Musical position only; absolute audio seconds are never persisted. */
  transport: TransportSnapshot;
  /** Partial take that is not in `session` yet, or null when idle. */
  recorder: RecorderDraft | null;
};
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const GRIDS = [0.25, 0.5, 1];
export function validateRecorderDraft(
  raw: unknown,
  session: Session,
): RecorderDraft | null {
  if (raw == null) return null;
  if (!object(raw)) throw new Error("录音草稿损坏");
  if (!["waiting", "recording", "recovered"].includes(raw.status as string))
    throw new Error("录音草稿状态无效");
  const track = session.tracks.find((t) => t.id === raw.trackId);
  if (!track) throw new Error("录音草稿的目标轨道已不存在");
  if (raw.instrument !== track.instrument) throw new Error("录音草稿乐器不匹配");
  if (!finite(raw.length, 4, 32) || raw.length !== session.beats)
    throw new Error("录音草稿长度与循环不符");
  if (
    !finite(raw.start, 0, 1e7) ||
    Math.abs((raw.start as number) % (raw.length as number)) > 1e-6
  )
    throw new Error("录音草稿起点无效");
  if (!GRIDS.includes(raw.grid as number)) throw new Error("录音吸附值无效");
  if (!finite(raw.progress, 0, 1e7)) throw new Error("录音进度无效");
  const progress = raw.progress as number,
    start = raw.start as number,
    length = raw.length as number;
  if (progress > start + length + 1e-6)
    throw new Error("录音进度超出本次录制范围");
  if (raw.status !== "waiting" && progress < start - 1e-6)
    throw new Error("录音进度与起点不符");
  if (typeof raw.transactionId !== "string" || !raw.transactionId)
    throw new Error("录音事务标识无效");
  const notes = validateNoteList(raw.notes, track.instrument, length);
  return {
    status: raw.status as RecorderDraft["status"],
    trackId: track.id,
    instrument: track.instrument,
    start,
    length,
    grid: raw.grid as number,
    notes,
    progress,
    transactionId: raw.transactionId,
  };
}
export function validateDraft(raw: unknown): DraftPayload {
  if (!object(raw) || raw.version !== DRAFT_VERSION)
    throw new Error("草稿格式或版本不受支持");
  if (!finite(raw.revision, 0, Number.MAX_SAFE_INTEGER))
    throw new Error("草稿修订号无效");
  if (!finite(raw.savedAt, 0, Number.MAX_SAFE_INTEGER))
    throw new Error("草稿时间无效");
  const session = validateSession(raw.session);
  const t = raw.transport;
  if (
    !object(t) ||
    !finite(t.bpm, 40, 220) ||
    ![4, 8, 16, 32].includes(t.beats as number) ||
    !finite(t.beat, 0, 1e7) ||
    typeof t.running !== "boolean" ||
    t.bpm !== session.bpm ||
    t.beats !== session.beats
  )
    throw new Error("草稿播放位置无效");
  return {
    version: DRAFT_VERSION,
    revision: raw.revision as number,
    savedAt: raw.savedAt as number,
    session,
    transport: {
      bpm: session.bpm,
      beats: session.beats,
      beat: t.beat as number,
      running: t.running as boolean,
    },
    recorder: validateRecorderDraft(raw.recorder, session),
  };
}
/**
 * Upgrade a version-1 draft shape into the current schema. It is deliberately
 * forgiving about missing optional fields, but any malformed field throws so
 * the caller can keep the original bytes and report the failure.
 */
export function upgradeDraft(raw: unknown): DraftPayload {
  if (!object(raw)) throw new Error("旧版草稿无法识别");
  if (raw.version === DRAFT_VERSION) return validateDraft(raw);
  if (raw.version !== 1) throw new Error("草稿版本不受支持");
  const session = validateSession(raw.session);
  const legacyTransport = object(raw.transport) ? raw.transport : {};
  // Old drafts may only have a wrapped loop position; treating it as the
  // absolute beat is safe because scheduling is loop-relative.
  const position = finite(legacyTransport.beat, 0, 1e7)
    ? legacyTransport.beat
    : finite(legacyTransport.position, 0, 1e7)
      ? legacyTransport.position
      : 0;
  const legacyRecorder = object(raw.recorder) ? raw.recorder : null;
  const recorder =
    legacyRecorder && typeof legacyRecorder.transactionId === "string"
      ? legacyRecorder
      : legacyRecorder
        ? {
            ...legacyRecorder,
            // Synthesize a deterministic id only for the in-memory upgrade;
            // the old bytes on disk remain untouched if validation fails.
            transactionId:
              typeof legacyRecorder.trackId === "string" &&
              finite(legacyRecorder.start, 0, 1e7)
                ? `legacy:${legacyRecorder.trackId}:${legacyRecorder.start}`
                : "",
          }
        : null;
  const upgraded = {
    version: DRAFT_VERSION,
    revision: finite(raw.revision, 0, Number.MAX_SAFE_INTEGER)
      ? raw.revision
      : 0,
    savedAt: finite(raw.savedAt, 0, Number.MAX_SAFE_INTEGER) ? raw.savedAt : 0,
    session,
    transport: {
      bpm: session.bpm,
      beats: session.beats,
      beat: position,
      // Recovery always re-opens paused: a stale `running` flag must not
      // start playback at the save position.
      running: false,
    },
    recorder,
  };
  return validateDraft(upgraded);
}
/** Convert a v1 manual session into a recovery draft without touching it. */
export function draftFromSession(session: Session, savedAt = Date.now()): DraftPayload {
  const valid = validateSession(session);
  return {
    version: DRAFT_VERSION,
    revision: 1,
    savedAt,
    session: valid,
    transport: {
      bpm: valid.bpm,
      beats: valid.beats,
      beat: 0,
      running: false,
    },
    recorder: null,
  };
}
export function encodeSlot(payload: DraftPayload) {
  const text = JSON.stringify(payload);
  return JSON.stringify({ c: checksum(text), p: text });
}
export function decodeSlot(text: string): DraftPayload {
  // `upgradeDraft` also accepts a bare v1 payload, which covers drafts that
  // predate checksummed slots.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("草稿数据无法解析");
  }
  if (object(body) && typeof body.p === "string" && typeof body.c === "string") {
    if (checksum(body.p) !== body.c) throw new Error("草稿校验失败");
    let payload: unknown;
    try {
      payload = JSON.parse(body.p);
    } catch {
      throw new Error("草稿数据无法解析");
    }
    return upgradeDraft(payload);
  }
  return upgradeDraft(body);
}
export function encodePointer(slot: string, revision: number) {
  const text = `${slot}:${revision}`;
  return JSON.stringify({ slot, revision, c: checksum(text) });
}
export function decodePointer(text: string | null): { slot: "A" | "B"; revision: number } | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    if (
      !object(raw) ||
      (raw.slot !== "A" && raw.slot !== "B") ||
      !finite(raw.revision, 0, Number.MAX_SAFE_INTEGER) ||
      typeof raw.c !== "string" ||
      checksum(`${raw.slot}:${raw.revision}`) !== raw.c
    )
      return null;
    return { slot: raw.slot, revision: raw.revision };
  } catch {
    return null;
  }
}
