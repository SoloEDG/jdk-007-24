import assert from "node:assert/strict";
import "./env.mjs";
const {
  decodeSlot,
  encodeSlot,
  encodePointer,
  decodePointer,
  validateDraft,
  validateRecorderDraft,
} = await import(
  "../src/features/persistence/model/draftSchema.ts"
);
const { checksum } = await import("../src/features/persistence/model/checksum.ts");
const storageMod = await import("../src/features/persistence/model/storage.ts");
const {
  writeDraft,
  loadDraft,
  clearDraft,
  claimTake,
  activeLease,
  currentRevision,
  readManualSession,
  writeManualSession,
  DRAFT_POINTER_KEY,
  LEGACY_DRAFT_KEY,
  MANUAL_KEY,
  leaseHolder,
  releaseLease,
} = storageMod;
const storage = globalThis.localStorage;
const track = {
  id: "t1",
  name: "鼓",
  instrument: "drums",
  color: "#d5f377",
  notes: [],
};
const session = {
  version: 1,
  title: "测试",
  bpm: 108,
  beats: 16,
  tracks: [track],
  channels: { t1: { volume: 0.75, muted: false } },
  master: 0.7,
};
const note = (beat = 0) => ({
  id: `n-${beat}-${Math.random()}`,
  pitch: 0,
  beat,
  duration: 0.25,
  velocity: 0.8,
});
const payload = (rev, partial = null) => ({
  version: 2,
  revision: rev,
  savedAt: 1_700_000_000_000,
  session: structuredClone(session),
  transport: { bpm: 108, beats: 16, beat: 4, running: false },
  recorder: partial,
});
const partial = (rev) => ({
  status: "recording",
  trackId: "t1",
  instrument: "drums",
  start: 0,
  length: 16,
  grid: 0.25,
  notes: [note(1)],
  progress: 4,
  transactionId: "take:t1:0:abc",
});
const reset = () => {
  clearDraft();
  storage.removeItem(MANUAL_KEY);
  storage.removeItem(LEGACY_DRAFT_KEY);
  storage.removeItem(storageMod.LEASE_KEY);
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("checksum is stable and detects single-char changes", () => {
  assert.equal(checksum("abc"), checksum("abc"));
  assert.notEqual(checksum("abc"), checksum("abd"));
});

test("draft round-trips through a checksummed slot", () => {
  reset();
  const doc = payload(1, partial(1));
  const encoded = encodeSlot(doc);
  const decoded = decodeSlot(encoded);
  assert.equal(decoded.revision, 1);
  assert.equal(decoded.recorder.notes.length, 1);
});

test("corrupted slot body fails checksum", () => {
  reset();
  const encoded = JSON.parse(encodeSlot(payload(1)));
  encoded.p = encoded.p.replace('"测试"', '"篡改"');
  assert.throws(() => decodeSlot(JSON.stringify(encoded)), /校验失败/);
});

test("pointer validates its own checksum", () => {
  const ok = encodePointer("A", 3);
  assert.deepEqual(decodePointer(ok), { slot: "A", revision: 3 });
  const raw = JSON.parse(ok);
  raw.revision = 99;
  assert.equal(decodePointer(JSON.stringify(raw)), null);
});

test("two-slot transaction keeps the previous complete draft", () => {
  reset();
  const first = writeDraft(payload(1, partial(1)), 1);
  assert.equal(first.ok, true);
  const second = writeDraft(payload(2, partial(2)), 2);
  assert.equal(second.ok, true);
  assert.notEqual(first.slot, second.slot);
  // Both slots hold a complete, independently valid version.
  const loaded = loadDraft();
  assert.equal(loaded.draft.payload.revision, 2);
});

test("a torn pointer falls back to the previous verifiable slot", () => {
  reset();
  writeDraft(payload(1, partial(1)), 1);
  const second = writeDraft(payload(2, partial(2)), 2);
  assert.equal(second.ok, true);
  // Simulate a crash after writing the new slot but corrupt it, then leave the
  // pointer aimed at the new revision.
  const slotKey = second.slot === "A" ? "nightshift-draft-slot-a" : "nightshift-draft-slot-b";
  storage.setItem(slotKey, '{"c":"deadbeef","p":"{\\"version\\":2}"}');
  const loaded = loadDraft();
  assert.ok(loaded.draft, "must still find a draft");
  assert.equal(loaded.draft.payload.revision, 1);
  assert.match(loaded.warning ?? "", /回退/);
});

test("quota failure preserves the last good version", () => {
  reset();
  assert.equal(writeDraft(payload(1, partial(1)), 1).ok, true);
  storage.failNext = 1;
  const result = writeDraft(payload(2, partial(2)), 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quota");
  assert.equal(result.keptRevision, 1);
  const loaded = loadDraft();
  assert.equal(loaded.draft.payload.revision, 1);
});

test("a failed pointer commit drops the orphan slot and keeps the old one", () => {
  reset();
  writeDraft(payload(1, partial(1)), 1);
  const original = storage.getItem(DRAFT_POINTER_KEY);
  // Fail the second setItem (the pointer write) exactly once.
  let calls = 0;
  const realSet = storage.setItem.bind(storage);
  storage.setItem = (k, v) => {
    if (k === DRAFT_POINTER_KEY && calls++ === 0) {
      throw new DOMException("boom", "QuotaExceededError");
    }
    return realSet(k, v);
  };
  const result = writeDraft(payload(2, partial(2)), 2);
  storage.setItem = realSet;
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(DRAFT_POINTER_KEY), original);
  assert.equal(loadDraft().draft.payload.revision, 1);
});

test("draft validation rejects a recording beyond its capture window", () => {
  assert.throws(
    () =>
      validateRecorderDraft(
        { ...partial(1), progress: 99 },
        session,
      ),
    /超出本次录制范围/,
  );
});

test("draft validation rejects notes outside the loop", () => {
  assert.throws(
    () =>
      validateDraft(
        payload(1, { ...partial(1), notes: [note(20)] }),
      ),
    /音符数据无效/,
  );
});

test("legacy v1 draft upgrades and keeps the original when unreadable", () => {
  reset();
  const legacy = {
    version: 1,
    revision: 7,
    savedAt: 123,
    session,
    transport: { position: 4, running: true },
    recorder: null,
  };
  storage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(legacy));
  const loaded = loadDraft();
  assert.ok(loaded.draft);
  assert.equal(loaded.draft.payload.transport.beat, 4);
  assert.equal(loaded.draft.payload.transport.running, false);
  assert.equal(storage.getItem(LEGACY_DRAFT_KEY), null, "migrated blob removed");
});

test("failed legacy upgrade leaves the original bytes intact", () => {
  reset();
  const broken = { version: 1, session: { version: 1 }, transport: {} };
  const raw = JSON.stringify(broken);
  storage.setItem(LEGACY_DRAFT_KEY, raw);
  const loaded = loadDraft();
  assert.equal(loaded.draft, null);
  assert.match(loaded.warning ?? "", /原始数据已保留/);
  assert.equal(storage.getItem(LEGACY_DRAFT_KEY), raw);
});

test("manual saves round-trip and survive draft clearing", () => {
  reset();
  writeManualSession(session);
  writeDraft(payload(1, null), 1);
  clearDraft();
  assert.equal(storage.getItem(DRAFT_POINTER_KEY), null);
  const loaded = readManualSession();
  assert.equal(loaded.title, "测试");
});

test("legacy bare manual save still loads", () => {
  reset();
  storage.setItem(MANUAL_KEY, JSON.stringify(session));
  assert.equal(readManualSession().title, "测试");
});

test("claimTake grants exactly one owner per transaction", async () => {
  reset();
  const id = "take:t1:0:race";
  const first = await claimTake(id, "owner-A");
  assert.ok(first);
  const second = await claimTake(id, "owner-B");
  assert.equal(second, null, "second owner must be refused");
  assert.equal(activeLease().owner, "owner-A");
  first.release();
  // Release is asynchronous from the lock's perspective; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const third = await claimTake(id, "owner-B");
  assert.ok(third, "after release the take can be claimed");
  third.release();
});

test("an abandoned lease does not block a new claim", async () => {
  reset();
  const id = "take:t1:0:stale";
  await globalThis.navigator.locks.request(`nightshift-take:${id}`, {}, async () => {});
  // Simulate a crashed tab that left only a lease behind.
  storage.setItem(
    storageMod.LEASE_KEY,
    JSON.stringify({
      transactionId: id,
      owner: "dead-tab",
      revision: 0,
      expiresAt: Date.now() + 60_000,
    }),
  );
  const claimed = await claimTake(id, "fresh");
  assert.ok(claimed, "a stale lease from a dead tab must not block recovery");
  claimed.release();
});

test("renewLease only succeeds for the current owner", async () => {
  reset();
  const id = "take:t1:0:renew";
  const claim = await claimTake(id, "me");
  assert.ok(claim);
  assert.equal(storageMod.renewLease("other"), false);
  assert.equal(storageMod.renewLease("me"), true);
  releaseLease("me");
  assert.equal(leaseHolder(id), null);
});

test("currentRevision reports the newest committed revision", () => {
  reset();
  writeDraft(payload(1, null), 1);
  writeDraft(payload(2, null), 2);
  assert.equal(currentRevision(), 2);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
if (failed) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log(`\n${tests.length} passing`);
