import assert from "node:assert/strict";
import "./env.mjs";
const { createRecorder } = await import("../src/features/recorder/model/recorder.ts");
const { createTransport } = await import("../src/features/transport/model/transport.ts");
const drum = (pitch = 0) => ({ pitch, velocity: 0.8, instrument: "drums" });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
/** Arm and return the loop-aligned start the recorder chose. */
const armed = (at = 0.5, beats = 16) => {
  const r = createRecorder();
  r.arm("t1", "drums", at, beats);
  return { r, start: r.snapshot().start, end: r.snapshot().start + beats, beats };
};

test("capture starts at the next loop boundary", () => {
  const { start, beats } = armed(0.5, 16);
  assert.equal(start, 16);
  assert.equal(beats, 16);
});

test("a full loop commits exactly once with all captured notes", () => {
  const { r, start, end } = armed();
  r.advance(start);
  r.down("k1", drum(), start);
  r.up("k1", start + 1);
  const take = r.advance(end);
  assert.ok(take);
  assert.equal(take.notes.length, 1);
  assert.equal(take.notes[0].beat, 0);
  assert.equal(r.snapshot().status, "idle");
});

test("a take that hits the loop end closes held keys at the boundary", () => {
  const { r, start, end, beats } = armed();
  r.advance(start);
  r.down("k1", drum(), end - 0.5);
  const take = r.advance(end);
  assert.ok(take);
  assert.equal(take.notes.length, 1);
  assert.ok(take.notes[0].beat + take.notes[0].duration <= beats + 1e-9);
});

test("nothing commits before the loop end", () => {
  const { r, start, end } = armed();
  r.advance(start);
  r.down("k1", drum(), start);
  assert.equal(r.advance(end - 0.1), null);
  assert.equal(r.snapshot().status, "recording");
});

test("freeze reports progress and never mutates live capture", () => {
  const { r, start } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 2);
  r.advance(start + 4);
  const frozen = r.freeze(start + 4);
  assert.ok(frozen);
  assert.equal(frozen.progress, start + 4);
  assert.equal(frozen.notes.length, 1, "held key is represented in the freeze");
  // Live state still knows the key is down; the freeze is a pure snapshot.
  assert.equal(r.snapshot().status, "recording");
  r.up("k1", start + 5);
  assert.equal(r.snapshot().draft.length, 1);
});

test("freeze while waiting stays in waiting state", () => {
  const { r, start } = armed();
  const frozen = r.freeze(start - 1);
  assert.ok(frozen);
  assert.equal(frozen.status, "waiting");
  assert.equal(frozen.notes.length, 0);
});

test("settle closes held keys at the pause beat and persists them", () => {
  const { r, start } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 2);
  r.settle(start + 6);
  const state = r.snapshot();
  assert.equal(state.draft.length, 1);
  assert.equal(state.progress, start + 6);
});

test("restore re-opens paused and refuses capture until confirmed", () => {
  const { r, start } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 1);
  const frozen = r.freeze(start + 4);
  r.cancel();

  const restored = createRecorder();
  assert.equal(restored.restore(frozen), true);
  const view = restored.snapshot();
  assert.equal(view.status, "recovered");
  assert.equal(view.draft.length, 1);
  // Advance must not finish or capture while unconfirmed.
  assert.equal(restored.advance(start + 16), null);
  assert.equal(restored.snapshot().status, "recovered");
  // Pressing keys must not silently resume capture.
  restored.down("k2", drum(1), start + 8);
  assert.equal(restored.snapshot().status, "recovered");
  assert.equal(restored.snapshot().draft.length, 1);
});

test("confirm resumes remaining beats and completes at the loop end", () => {
  const { r, start, end } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 1);
  const frozen = r.freeze(start + 4);
  r.cancel();

  const restored = createRecorder();
  restored.restore(frozen);
  assert.equal(restored.confirm(), true);
  const state = restored.snapshot();
  assert.equal(state.status, "recording");
  assert.equal(state.resumeAt, start + 4);
  restored.advance(start + 8);
  restored.down("k2", drum(1), start + 9);
  const take = restored.advance(end);
  assert.ok(take);
  assert.equal(take.transactionId, frozen.transactionId);
  assert.equal(take.notes.length, 2, "pre-crash and resumed notes are both kept");
});

test("discarding a recovered take leaves nothing behind", () => {
  const { r, start } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 1);
  const frozen = r.freeze(start + 4);
  r.cancel();
  const restored = createRecorder();
  restored.restore(frozen);
  restored.discard();
  assert.equal(restored.snapshot().status, "idle");
});

test("persistable keeps a recovered take exactly as saved", () => {
  const { r, start } = armed();
  r.advance(start);
  r.down("k1", drum(), start + 1);
  const frozen = r.freeze(start + 4);
  r.cancel();
  const restored = createRecorder();
  restored.restore(frozen);
  const again = restored.persistable(start + 99);
  assert.equal(again.status, "recovered");
  assert.equal(again.progress, frozen.progress);
});

test("transport restore creates a paused, note-free position", () => {
  const t = createTransport();
  t.restore({ bpm: 120, beats: 16, beat: 7.5, running: true });
  const freshNow = 5000; // arbitrary new audio clock
  const view = t.view(freshNow);
  assert.equal(view.running, false);
  assert.equal(view.absolute, 7.5);
  // The scheduler must not emit a backlog after restart.
  assert.equal(t.window(freshNow), null);
});

test("starting after restore schedules from the saved beat, not from zero", () => {
  const t = createTransport();
  t.restore({ bpm: 120, beats: 16, beat: 7.5, running: false });
  // Brand-new audio anchor, well away from the closed page's timeline.
  t.start(10_000);
  const w = t.window(10_001);
  assert.ok(w);
  // 1 second at 120 BPM = 2 beats, so the window starts around 9.5 beats.
  assert.ok(w.from >= 7.5);
  assert.ok(w.from < 10);
});

test("a restored beat survives a long gap without advancing playback", () => {
  const t = createTransport();
  t.restore({ bpm: 120, beats: 16, beat: 3, running: false });
  // Simulate an hour of wall-clock/audio time before the user presses play.
  assert.equal(t.view(3600).absolute, 3);
  t.start(3600);
  // First scheduled window starts at the restored beat, not an hour ahead.
  const w = t.window(3600.001);
  assert.ok(w);
  assert.ok(w.from < 4);
});

test("window ceiling stops scheduling past a capture boundary", () => {
  const t = createTransport();
  t.restore({ bpm: 120, beats: 16, beat: 0, running: false });
  t.start(0);
  assert.equal(t.window(0.01, 0), null, "nothing may be scheduled past the ceiling");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n     ${error.stack ?? error.message}`);
  }
}
if (failed) process.exit(1);
console.log(`\n${tests.length} passing`);
