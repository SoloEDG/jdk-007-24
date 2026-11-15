import assert from "node:assert/strict";
import { tickAudio, fireWindow, fireDocument, setVisibility } from "./browser.mjs";
const { createStudio } = await import("../src/app/studio.ts");
const storageMod = await import("../src/features/persistence/model/storage.ts");
const { readManualSession } = storageMod;
const storage = globalThis.localStorage;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (predicate, timeout = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
/** Open a studio, drive it, then dispose it as a page close would. */
const live = new Set();
const open = () => {
  const studio = createStudio(() => {});
  live.add(studio);
  return studio;
};
const close = (studio) => {
  studio.dispose();
  live.delete(studio);
};
const closeAll = () => {
  for (const studio of live) studio.dispose();
  live.clear();
};
const reset = () => {
  storage.clear();
  globalThis.__unused = null;
};
/** Add a drum track and return its id. */
const addTrack = (studio) => {
  studio.add("drums");
  return studio.view().selected.id;
};
const state = (studio) => studio.view();

test("a new studio does not prompt and writes no draft", () => {
  reset();
  const s = open();
  assert.equal(state(s).recovery, null);
  assert.equal(loadDraftAfter(), null);
  close(s);
  function loadDraftAfter() {
    return storageMod.loadDraft().draft;
  }
});

test("edits are autosaved and recoverable after a crash close", async () => {
  reset();
  const s = open();
  addTrack(s);
  assert.ok(
    await waitFor(() => !!storageMod.loadDraft().draft),
    "draft must exist after an edit",
  );
  // Reopen without disposing the first instance to mimic a crash.
  const reopened = open();
  const v = state(reopened);
  assert.ok(v.recovery, "reopen must prompt for recovery");
  assert.equal(v.recovery.summary.tracks, 1);
  assert.equal(v.recovery.summary.partial, null);
  reopened.recoverDraft();
  await flush();
  const after = state(reopened);
  assert.equal(after.recovery, null);
  assert.equal(after.arrangement.tracks.length, 1);
  assert.equal(after.transport.running, false, "recovery opens paused");
  close(reopened);
  // The crashed instance's timers keep running in this shim; dispose it late
  // so it cannot overwrite the reopened draft.
  close(s);
});

test("a partial recording survives a crash and resumes paused", async () => {
  reset();
  const s = open();
  addTrack(s);
  await s.record();
  // Capture begins at the next loop boundary (16 beats ≈ 8.9s at 108 BPM).
  const start = state(s).recorder.start;
  tickAudio((start * 60) / 108 + 0.05);
  assert.ok(await waitFor(() => state(s).recorder.status === "recording"));
  // Capture a note inside the loop.
  s.down("k1", { pitch: 0, velocity: 0.8, instrument: "drums" });
  await flush();
  tickAudio(0.4);
  s.up("k1");
  // Advance two more beats so progress is well past the start.
  tickAudio((2 * 60) / 108);
  assert.ok(await waitFor(() => !!storageMod.loadDraft().draft?.payload.recorder));
  // The autosave already persisted a partial while the take was live — this
  // is what a crash would leave behind. Capture it before closing.
  const draft = storageMod.loadDraft().draft;
  assert.ok(draft, "a draft exists");
  assert.ok(draft.payload.recorder, "partial take is persisted");
  const savedProgress = draft.payload.recorder.progress;
  assert.ok(savedProgress > draft.payload.recorder.start);
  const crashNotes = draft.payload.recorder.notes.length;
  // Now the tab goes away, releasing its Web Lock.
  close(s);

  const reopened = open();
  await flush();
  const rv = state(reopened).recovery;
  assert.ok(rv, "reopen prompts");
  assert.ok(rv.summary.partial, "prompt shows a partial take");
  assert.ok(
    rv.summary.partial.progress >= savedProgress,
    "prompt reflects at least the crash-time progress",
  );
  reopened.recoverDraft();
  await flush();
  const after = state(reopened);
  assert.equal(after.recovery, null);
  assert.equal(
    after.recorder.status,
    "recovered",
    "restored paused for confirmation",
  );
  assert.equal(after.transport.running, false);
  assert.ok(
    after.recorder.progress >= savedProgress,
    "progress is preserved, not replayed",
  );
  assert.ok(
    after.recorder.draft.length >= crashNotes,
    "draft notes captured before the crash are kept",
  );
  // Confirming continues from the saved musical position with a new anchor.
  await reopened.confirmRecovered();
  await flush();
  const confirmed = state(reopened);
  assert.equal(confirmed.recorder.status, "recording");
  assert.equal(confirmed.transport.running, true);
  close(reopened);
});

test("discarding a draft leaves the manual save intact", async () => {
  reset();
  const seed = open();
  addTrack(seed);
  seed.save();
  await flush();
  assert.ok(readManualSession().tracks.length === 1);
  close(seed);

  const s = open();
  assert.ok(state(s).recovery);
  s.discardDraft();
  await flush();
  assert.equal(state(s).recovery, null);
  // The manual save is untouched and independently loadable.
  const manual = readManualSession();
  assert.equal(manual.tracks.length, 1);
  s.load();
  await flush();
  assert.equal(state(s).arrangement.tracks.length, 1);
  close(s);
});

test("a manual save stays independent of draft autosaves", async () => {
  reset();
  const s = open();
  addTrack(s);
  s.save();
  await flush();
  const saved = readManualSession();
  // Further edits only touch the draft.
  s.add("keys");
  assert.ok(
    await waitFor(
      () =>
        storageMod.loadDraft().draft?.payload.session.tracks.length ===
        saved.tracks.length + 1,
    ),
    "the draft tracks the edit",
  );
  assert.equal(readManualSession().tracks.length, saved.tracks.length);
  close(s);
});

test("recovery rejects a corrupted newest slot and falls back", async () => {
  reset();
  const s = open();
  addTrack(s);
  assert.ok(await waitFor(() => !!storageMod.loadDraft().draft));
  const first = storageMod.loadDraft().draft;
  s.add("keys");
  assert.ok(await waitFor(() => storageMod.currentRevision() > first.payload.revision));
  const pointer = JSON.parse(storage.getItem(storageMod.DRAFT_POINTER_KEY));
  const key =
    pointer.slot === "A" ? "nightshift-draft-slot-a" : "nightshift-draft-slot-b";
  storage.setItem(key, '{"c":"00000000","p":"{}"}');
  close(s);
  const reopened = open();
  const v = state(reopened);
  assert.ok(v.recovery);
  assert.match(v.recovery.warning ?? "", /回退/);
  assert.equal(v.recovery.summary.tracks, first.payload.session.tracks.length);
  close(reopened);
});

test("one window only may take over a live recording transaction", async () => {
  reset();
  const a = open();
  addTrack(a);
  await a.record();
  assert.ok(await waitFor(() => !!storageMod.loadDraft().draft?.payload.recorder));
  const take = state(a).recorder.transactionId;
  assert.ok(take);
  // Second window opens while the first is alive.
  const b = open();
  await flush();
  const vb = state(b);
  assert.ok(vb.recovery, "second window sees the draft");
  // Choosing 恢复 tries to claim the live transaction and is refused.
  b.recoverDraft();
  assert.ok(
    await waitFor(() => state(b).readOnly),
    "the second window becomes read-only after a failed takeover",
  );
  assert.equal(state(b).recovery?.takenOver, true, "recover is refused");
  assert.equal(state(a).recorder.status !== "idle", true, "owner keeps the take");
  // Discarding from the non-owner only dismisses the prompt.
  b.discardDraft();
  await flush();
  assert.ok(storageMod.loadDraft().draft, "draft bytes survive a read-only discard");
  close(b);
  close(a);
});

test("legacy v1 draft is upgraded in place", async () => {
  reset();
  const legacy = {
    version: 1,
    revision: 5,
    savedAt: 1,
    session: {
      version: 1,
      title: "旧草稿",
      bpm: 90,
      beats: 8,
      tracks: [],
      channels: {},
      master: 0.5,
    },
    transport: { position: 2, running: true },
    recorder: null,
  };
  storage.setItem(storageMod.LEGACY_DRAFT_KEY, JSON.stringify(legacy));
  const s = open();
  const v = state(s);
  assert.ok(v.recovery);
  assert.equal(v.recovery.summary.bpm, 90);
  assert.match(v.recovery.warning ?? "", /升级/);
  assert.equal(storage.getItem(storageMod.LEGACY_DRAFT_KEY), null);
  close(s);
});

test("failed legacy upgrade preserves the original and reports it", async () => {
  reset();
  const raw = JSON.stringify({ version: 1, session: { version: 1 } });
  storage.setItem(storageMod.LEGACY_DRAFT_KEY, raw);
  const s = open();
  const v = state(s);
  assert.equal(v.recovery, null);
  assert.match(v.message, /原始数据已保留/);
  assert.equal(storage.getItem(storageMod.LEGACY_DRAFT_KEY), raw);
  close(s);
});

test("hidden page flushes a live take without ending it", async () => {
  reset();
  const s = open();
  addTrack(s);
  await s.record();
  const start = state(s).recorder.start;
  tickAudio((start * 60) / 108 + 0.05);
  assert.ok(await waitFor(() => state(s).recorder.status === "recording"));
  tickAudio(1);
  setVisibility("hidden");
  fireDocument("visibilitychange");
  const draft = storageMod.loadDraft().draft;
  assert.ok(draft);
  assert.ok(draft.payload.recorder, "a live partial is written on hide");
  setVisibility("visible");
  fireDocument("visibilitychange");
  assert.equal(state(s).recorder.status, "recording", "recording continues after return");
  close(s);
});

test("beforeunload leaves a complete draft behind", async () => {
  reset();
  const s = open();
  addTrack(s);
  await s.record();
  const start = state(s).recorder.start;
  tickAudio((start * 60) / 108 + 0.05);
  assert.ok(await waitFor(() => state(s).recorder.status === "recording"));
  tickAudio(2);
  fireWindow("beforeunload");
  const draft = storageMod.loadDraft().draft;
  assert.ok(draft?.payload.recorder);
  assert.ok(draft.payload.recorder.progress > draft.payload.recorder.start);
  close(s);
});

test("a quota failure surfaces a notice and keeps the last revision", async () => {
  reset();
  const s = open();
  addTrack(s);
  assert.ok(await waitFor(() => storageMod.currentRevision() > 0));
  const kept = storageMod.currentRevision();
  // Make every subsequent write fail.
  storage.failNext = 1000;
  s.add("keys");
  assert.ok(
    await waitFor(() => !!state(s).saveNotice),
    "a save notice is shown",
  );
  const v = state(s);
  assert.equal(v.saveNotice.kind, "quota");
  assert.ok(
    v.saveNotice.keptRevision === kept,
    "the last verifiable revision is reported",
  );
  assert.equal(storageMod.currentRevision(), kept, "old draft is intact");
  storage.failNext = 0;
  close(s);
});

test("recovery never back-fills notes from the closed period", async () => {
  reset();
  const s = open();
  addTrack(s);
  await s.record();
  const start = state(s).recorder.start;
  tickAudio((start * 60) / 108 + 0.05);
  assert.ok(await waitFor(() => state(s).recorder.status === "recording"));
  // Let a moment of music pass, then crash.
  tickAudio(1);
  // Dispose flushes the exact close-time position; read it after the close.
  close(s);
  const saved = storageMod.loadDraft().draft;
  assert.ok(saved?.payload.recorder);
  const savedBeat = saved.payload.transport.beat;
  assert.ok(savedBeat > 0, "a real musical position was saved");

  // A long wall-clock gap stands in for the page being closed for hours.
  tickAudio(3600);
  const reopened = open();
  assert.ok(state(reopened).recovery);
  assert.equal(
    state(reopened).transport.absolute,
    0,
    "nothing is loaded before the user chooses",
  );
  reopened.recoverDraft();
  assert.ok(
    await waitFor(() => state(reopened).recovery === null),
    "recovery prompt resolves",
  );
  const v = state(reopened);
  assert.equal(v.transport.running, false, "recovered session stays paused");
  assert.ok(
    Math.abs(v.transport.absolute - savedBeat) < 1e-6,
    `the musical position is preserved exactly (got ${v.transport.absolute}, want ${savedBeat})`,
  );
  // The transport ignores the huge audio gap until the user starts playback.
  assert.equal(v.transport.absolute, savedBeat);
  close(reopened);
});

test("a completed take replaces the track atomically", async () => {
  reset();
  const s = open();
  addTrack(s);
  await s.record();
  const r = state(s).recorder;
  const end = r.start + r.length;
  tickAudio((r.start * 60) / 108 + 0.05);
  assert.ok(await waitFor(() => state(s).recorder.status === "recording"));
  s.down("k1", { pitch: 0, velocity: 0.8, instrument: "drums" });
  await flush();
  s.up("k1");
  // Jump straight to the loop end so the take completes.
  tickAudio(((end - r.start) * 60) / 108);
  assert.ok(
    await waitFor(() => state(s).recorder.status === "idle"),
    "take finishes at the loop end",
  );
  const committed = state(s).arrangement.tracks[0].notes;
  assert.equal(committed.length, 1);
  assert.ok(await waitFor(() => !storageMod.loadDraft().draft?.payload.recorder));
  assert.equal(
    storageMod.loadDraft().draft.payload.session.tracks[0].notes.length,
    1,
    "the committed take is the persisted draft",
  );
  close(s);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n     ${error.stack ?? error.message}`);
  } finally {
    closeAll();
  }
}
if (failed) process.exit(1);
console.log(`\n${tests.length} passing`);
