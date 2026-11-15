import type { DraftPayload } from "./draftSchema";
import {
  DRAFT_VERSION,
  decodePointer,
  decodeSlot,
  draftFromSession,
  encodePointer,
  encodeSlot,
  upgradeDraft,
  validateDraft,
} from "./draftSchema";
import type { Session } from "@/shared/types";
import { validateSession } from "@/features/arrangement/lib/validation";
import { checksum } from "./checksum";
const SLOT_KEYS = {
  A: "nightshift-draft-slot-a",
  B: "nightshift-draft-slot-b",
} as const;
export const DRAFT_POINTER_KEY = "nightshift-draft-pointer";
export const LEASE_KEY = "nightshift-draft-lease";
/** Manual saves stay on their own key and never share a transaction with drafts. */
export const MANUAL_KEY = "nightshift-session-v1";
/** Pre-slot drafts (version 1) are migrated, never overwritten in place. */
export const LEGACY_DRAFT_KEY = "nightshift-draft-v1";
const MAX_DRAFT_BYTES = 3_000_000;
type Slot = keyof typeof SLOT_KEYS;
export type DraftRead = {
  payload: DraftPayload;
  /** `slot` is the pointer target; `fallback` means the other slot was used. */
  source: "slot" | "fallback" | "legacy";
};
export type DraftLoad = {
  draft: DraftRead | null;
  /** Surfaced even when `draft` is null (e.g. a failed legacy upgrade). */
  warning: string | null;
};
export type DraftWrite =
  | { ok: true; revision: number; slot: Slot }
  | {
      ok: false;
      reason: "quota" | "io";
      message: string;
      /** Last version that still verifies, so callers can report it honestly. */
      keptRevision: number | null;
    };
class QuotaError extends Error {}
const isQuota = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22);
function rawGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function rawSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    if (isQuota(error)) throw new QuotaError("空间不足");
    throw error;
  }
}
function rawRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* a removal failure cannot corrupt anything */
  }
}
function readSlot(slot: Slot): DraftPayload | null {
  const text = rawGet(SLOT_KEYS[slot]);
  if (!text) return null;
  if (text.length > MAX_DRAFT_BYTES) return null;
  try {
    return decodeSlot(text);
  } catch {
    return null;
  }
}
type LegacyMigration =
  | { found: false }
  | { found: true; draft: DraftRead | null; warning: string };
function migrateLegacyDraft(): LegacyMigration {
  const text = rawGet(LEGACY_DRAFT_KEY);
  if (!text) return { found: false };
  if (text.length > MAX_DRAFT_BYTES)
    return {
      found: true,
      draft: null,
      warning: "旧版草稿过大，无法升级；原始数据已保留。",
    };
  let payload: DraftPayload;
  try {
    payload = upgradeDraft(JSON.parse(text));
  } catch {
    return {
      found: true,
      draft: null,
      warning: "旧版草稿升级失败；原始数据已保留，未做任何删除。",
    };
  }
  const written = writeDraft(payload, Math.max(1, payload.revision));
  // Only drop the legacy blob after the new schema was accepted AND a slot
  // write verifies; a failed upgrade or quota error keeps it untouched.
  if (written.ok) rawRemove(LEGACY_DRAFT_KEY);
  return {
    found: true,
    draft: {
      payload: written.ok
        ? { ...payload, revision: written.revision }
        : payload,
      source: "legacy",
    },
    warning: written.ok
      ? "旧版草稿已升级为新格式。"
      : `旧版草稿可读，但暂时无法写入新格式（${written.message}）；原始数据已保留。`,
  };
}
/**
 * Read the newest verifiable draft. The pointer is only a hint: if it points
 * at a corrupt/truncated slot we fall back to whichever slot still verifies so
 * the user never silently loses the last good version.
 */
export function loadDraft(): DraftLoad {
  const pointer = decodePointer(rawGet(DRAFT_POINTER_KEY));
  const a = readSlot("A"),
    b = readSlot("B");
  let payload: DraftPayload | null = null;
  let source: DraftRead["source"] = "slot";
  let warning: string | null = null;
  if (pointer) {
    const pointed = pointer.slot === "A" ? a : b;
    if (pointed && pointed.revision === pointer.revision) payload = pointed;
    else {
      const other = pointer.slot === "A" ? b : a;
      if (other) {
        payload = other;
        source = "fallback";
        warning = "检测到未写完整的草稿，已回退到上一个可校验版本。";
      }
    }
  }
  if (!payload) {
    const candidates = [a, b].filter((x): x is DraftPayload => !!x);
    if (candidates.length) {
      payload = candidates.sort((x, y) => y.revision - x.revision)[0];
      source = "fallback";
      if (a && b) warning = "草稿指针缺失，已选用可校验的最新版本。";
    }
  }
  if (payload) return { draft: { payload, source }, warning };
  const legacy = migrateLegacyDraft();
  if (legacy.found) return { draft: legacy.draft, warning: legacy.warning };
  return { draft: null, warning: null };
}
export function readDraft(): DraftRead | null {
  return loadDraft().draft;
}
/**
 * Current manual saves are checksummed and stay independently loadable via the
 * 恢复 button, so they never trigger a recovery prompt. This helper exists for
 * detecting a bare pre-draft (version-1) save that a user may still want to
 * hand-load; it deliberately does not seed automatic recovery.
 */
export function readManualAsDraft(): DraftRead | null {
  const text = rawGet(MANUAL_KEY);
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    if (
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).p === "string" &&
      typeof (body as Record<string, unknown>).c === "string"
    )
      return null;
    const session = validateSession(body);
    return { payload: draftFromSession(session), source: "legacy" };
  } catch {
    return null;
  }
}
function decodeManual(raw: string): Session {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("手动存档无法解析，原数据已保留");
  }
  // Current manual saves use a checksummed envelope; bare v1 sessions are
  // still accepted so older saves keep loading.
  if (
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).p === "string" &&
    typeof (body as Record<string, unknown>).c === "string"
  ) {
    const wrapper = body as { p: string; c: string };
    if (checksum(wrapper.p) !== wrapper.c)
      throw new Error("手动存档校验失败，原数据已保留");
    try {
      body = JSON.parse(wrapper.p);
    } catch {
      throw new Error("手动存档无法解析，原数据已保留");
    }
  }
  return validateSession(body);
}
export function readManualSession(): Session {
  const text = rawGet(MANUAL_KEY);
  if (!text) throw new Error("还没有本地存档，请先保存");
  if (text.length > MAX_DRAFT_BYTES) throw new Error("存档过大，已保留当前作品");
  return decodeManual(text);
}
export function writeManualSession(session: Session) {
  const safe = validateSession(session);
  const text = JSON.stringify(safe);
  rawSet(MANUAL_KEY, JSON.stringify({ c: checksum(text), p: text }));
}
export function hasManualSession() {
  return !!rawGet(MANUAL_KEY);
}
/** Combined recovery sources, used to decide whether to prompt on open. */
export type RecoverySources = {
  draft: DraftLoad;
  manual: DraftRead | null;
};
export function recoverySources(): RecoverySources {
  return { draft: loadDraft(), manual: readManualAsDraft() };
}
/**
 * Summarize a draft for the recovery prompt without exposing internals:
 * whether a partial take exists, how far it got, and where it stopped.
 */
export function draftSummary(payload: DraftPayload) {
  const r = payload.recorder;
  const track = r ? payload.session.tracks.find((t) => t.id === r.trackId) : null;
  return {
    version: payload.version,
    revision: payload.revision,
    savedAt: payload.savedAt,
    title: payload.session.title,
    tracks: payload.session.tracks.length,
    bpm: payload.session.bpm,
    beats: payload.session.beats,
    beat: payload.transport.beat,
    wasRunning: payload.transport.running,
    partial: r
      ? {
          trackId: r.trackId,
          trackName: track?.name ?? "已移除的轨道",
          notes: r.notes.length,
          start: r.start,
          length: r.length,
          progress: r.progress,
          remaining: Math.max(0, r.start + r.length - r.progress),
          status: r.status,
        }
      : null,
  };
}
export type DraftSummary = ReturnType<typeof draftSummary>;
export function clearDraft() {
  rawRemove(SLOT_KEYS.A);
  rawRemove(SLOT_KEYS.B);
  rawRemove(DRAFT_POINTER_KEY);
}
function readRevision(slot: Slot | undefined) {
  return slot ? (readSlot(slot)?.revision ?? null) : null;
}
/**
 * Transactional two-slot write:
 *  1. serialize + checksum the whole new draft,
 *  2. write it into the slot the pointer does NOT reference,
 *  3. read it back and verify,
 *  4. only then flip the pointer.
 * A crash or quota error before step 4 leaves the previous complete draft
 * reachable, so a half-written new take can never replace a good one.
 */
export function writeDraft(payload: DraftPayload, revision?: number): DraftWrite {
  const nextRevision = revision ?? payload.revision;
  let validated: DraftPayload;
  try {
    validated = validateDraft({
      ...payload,
      version: DRAFT_VERSION,
      revision: nextRevision,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "io",
      message: error instanceof Error ? error.message : "草稿校验失败",
      keptRevision: null,
    };
  }
  const pointer = decodePointer(rawGet(DRAFT_POINTER_KEY));
  const target: Slot = pointer?.slot === "A" ? "B" : "A";
  const keptSlot = pointer?.slot ?? (target === "A" ? "B" : "A");
  const keptRevision = readRevision(keptSlot);
  const encoded = encodeSlot(validated);
  if (encoded.length > MAX_DRAFT_BYTES)
    return {
      ok: false,
      reason: "quota",
      message: "草稿超出浏览器可保存容量，已保留上一个可恢复版本。",
      keptRevision,
    };
  const failure = (error: unknown, committed: boolean): DraftWrite => {
    if (!committed) rawRemove(SLOT_KEYS[target]);
    const quota = error instanceof QuotaError;
    return {
      ok: false,
      reason: quota ? "quota" : "io",
      message: quota
        ? "浏览器存储空间不足，已保留上一个可校验版本。请清理空间后重试。"
        : "草稿写入中断，已保留上一个可校验版本。",
      keptRevision,
    };
  };
  try {
    rawSet(SLOT_KEYS[target], encoded);
  } catch (error) {
    return failure(error, false);
  }
  // Read-back catches partial writes where the platform still reports success.
  if (rawGet(SLOT_KEYS[target]) !== encoded) return failure("readback", false);
  try {
    const encodedPointer = encodePointer(target, validated.revision);
    rawSet(DRAFT_POINTER_KEY, encodedPointer);
    if (rawGet(DRAFT_POINTER_KEY) !== encodedPointer)
      throw new Error("pointer read-back failed");
  } catch (error) {
    // The new slot is complete but unreferenced; the old pointer target
    // remains authoritative. Remove the orphan to free space.
    rawRemove(SLOT_KEYS[target]);
    return failure(error, true);
  }
  return { ok: true, revision: validated.revision, slot: target };
}
export function currentRevision() {
  const pointer = decodePointer(rawGet(DRAFT_POINTER_KEY));
  if (pointer) return readRevision(pointer.slot) ?? 0;
  return Math.max(readRevision("A") ?? 0, readRevision("B") ?? 0);
}
export type LeaseState = {
  /** Stable id of this recording transaction (track + start beat + generation). */
  transactionId: string;
  owner: string;
  revision: number;
  expiresAt: number;
};
function readLease(): LeaseState | null {
  const text = rawGet(LEASE_KEY);
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<LeaseState>;
    if (
      !raw ||
      typeof raw.transactionId !== "string" ||
      typeof raw.owner !== "string" ||
      typeof raw.expiresAt !== "number" ||
      !Number.isFinite(raw.expiresAt) ||
      typeof raw.revision !== "number"
    )
      return null;
    return raw as LeaseState;
  } catch {
    return null;
  }
}
function writeLease(lease: LeaseState) {
  try {
    rawSet(LEASE_KEY, JSON.stringify(lease));
    return true;
  } catch {
    return false;
  }
}
/** The live lease, or null when absent/expired. */
export function activeLease(now = Date.now()): LeaseState | null {
  const lease = readLease();
  return lease && lease.expiresAt > now ? lease : null;
}
export function leaseHolder(transactionId: string, now = Date.now()) {
  const lease = activeLease(now);
  if (!lease || lease.transactionId !== transactionId) return null;
  return lease.owner;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function hasWebLocks() {
  return (
    typeof navigator !== "undefined" &&
    "locks" in navigator &&
    !!navigator.locks &&
    typeof navigator.locks.request === "function"
  );
}
/**
 * Hold a named Web Lock for the lifetime of the returned release function.
 * `null` means the lock is unavailable because another live tab holds it.
 *
 * Lock release is queued asynchronously by the platform, so a caller that just
 * released a take (page reload, immediate reopen) can briefly see its own lock
 * as held. We retry a few times before concluding a foreign tab owns it; a
 * genuinely held lock simply fails every attempt.
 */
function acquireWebLock(
  name: string,
  attempts = 4,
  delayMs = 30,
): Promise<(() => void) | null> {
  const attempt = (remaining: number): Promise<(() => void) | null> =>
    new Promise<(() => void) | null>((resolve) => {
      let settled = false;
      const settle = (value: (() => void) | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            settle(null);
            return undefined;
          }
          // Keep the lock until the caller releases it. The request promise
          // stays pending, which is how Web Locks models a held lock.
          return new Promise<void>((release) => settle(release));
        })
        .catch(() => settle(null));
    }).then(async (release) => {
      if (release) return release;
      if (remaining <= 1) return null;
      await sleep(delayMs);
      return attempt(remaining - 1);
    });
  return attempt(attempts);
}
export type TakeClaim = {
  transactionId: string;
  owner: string;
  release: () => void;
};
const heldClaims = new Map<string, TakeClaim>();
/**
 * Exclusively own one recording transaction. Web Locks gives true liveness
 * (a crashed/closed tab releases immediately); the persisted lease is the
 * signal other tabs and non-Web-Locks browsers see, with a short TTL so a
 * stale owner cannot block recovery forever.
 */
export async function claimTake(
  transactionId: string,
  owner: string,
  ttlMs = 8000,
): Promise<TakeClaim | null> {
  if (heldClaims.has(transactionId)) return null;
  let releaseWeb: (() => void) | null = null;
  const webLocks = hasWebLocks();
  if (webLocks) {
    releaseWeb = await acquireWebLock(`nightshift-take:${transactionId}`);
    // Another live tab already owns this take.
    if (!releaseWeb) return null;
  }
  const current = readLease();
  const now = Date.now();
  // Without Web Locks we must trust the lease. A live foreign owner blocks us;
  // with Web Locks the acquired lock already proves nobody else is active, so
  // a leftover lease from a crashed tab is safe to take over.
  if (
    !webLocks &&
    current &&
    current.transactionId === transactionId &&
    current.owner !== owner &&
    current.expiresAt > now
  ) {
    releaseWeb?.();
    return null;
  }
  if (
    !writeLease({
      transactionId,
      owner,
      revision: current?.revision ?? 0,
      expiresAt: now + ttlMs,
    })
  ) {
    releaseWeb?.();
    return null;
  }
  if (!webLocks) {
    // Two tabs can write back-to-back; settle and confirm we won.
    await sleep(40);
    const confirmed = readLease();
    if (
      !confirmed ||
      confirmed.transactionId !== transactionId ||
      confirmed.owner !== owner
    )
      return null;
  }
  const claim: TakeClaim = {
    transactionId,
    owner,
    release() {
      heldClaims.delete(transactionId);
      releaseWeb?.();
      const lease = readLease();
      if (lease?.owner === owner && lease.transactionId === transactionId)
        rawRemove(LEASE_KEY);
    },
  };
  heldClaims.set(transactionId, claim);
  return claim;
}
export function renewLease(owner: string, ttlMs = 8000) {
  const current = readLease();
  if (!current || current.owner !== owner) return false;
  return writeLease({ ...current, expiresAt: Date.now() + ttlMs });
}
export function releaseLease(owner: string) {
  const current = readLease();
  if (current?.owner === owner) rawRemove(LEASE_KEY);
}
