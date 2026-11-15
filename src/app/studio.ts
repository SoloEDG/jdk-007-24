import { createEngine, bindPerformanceInput } from "@/features/instruments";
import { createTransport, scheduleWindow } from "@/features/transport";
import { createRecorder } from "@/features/recorder";
import { createArrangement, demoSession } from "@/features/arrangement";
// `saveSession` / `loadSession` moved into the persistence feature so drafts
// and manual saves share one validated codec without circular imports.
import {
  clearDraft,
  claimTake,
  currentRevision,
  draftSummary,
  hasManualSession,
  readManualSession,
  recoverySources,
  renewLease,
  writeDraft,
  writeManualSession,
  type DraftPayload,
  type DraftRead,
  type DraftSummary,
  type TakeClaim,
} from "@/features/persistence";
import { createMixer } from "@/features/mixer";
import type {
  Instrument,
  Note,
  NoteInput,
  RecorderDraft,
  Session,
} from "@/shared/types";
export type RecoveryPrompt = {
  summary: DraftSummary;
  /** Notes already committed to the original track, for side-by-side review. */
  original: Note[];
  /** Partial notes that were captured before the page closed. */
  draft: Note[];
  warning: string | null;
  /** True when another live window currently owns this take. */
  takenOver: boolean;
  /** True when the draft came from a legacy manual save rather than a draft. */
  fromManual: boolean;
};
export type SaveNotice = {
  kind: "quota" | "io";
  message: string;
  keptRevision: number | null;
} | null;
const AUTO_WRITE_MS = 300;
const RETRY_WRITE_MS = 1500;
export function createStudio(notify: () => void) {
  const engine = createEngine(),
    transport = createTransport(),
    recorder = createRecorder(),
    arrangement = createArrangement(),
    mixer = createMixer();
  const owner = crypto.randomUUID();
  const active = new Set<string>();
  let message = "欢迎来到夜航。戴上耳机，试着敲下第一拍。",
    epoch = 0,
    disposed = false,
    revision = 0,
    saveNotice: SaveNotice = null,
    recovery: RecoveryPrompt | null = null,
    recoverySource: DraftRead | null = null,
    manualAvailable = hasManualSession(),
    claim: TakeClaim | null = null,
    /** Set when another window owns this take; this window must not write. */
    readOnly = false,
    dirty = true,
    lastSavedBeat = 0,
    lastWriteAt = 0,
    lastStatus = "idle";
  const now = () => engine.context?.currentTime ?? 0;
  const feedback = (text: string) => {
    message = text;
    notify();
  };
  const guard = (fn: () => void) => {
    try {
      fn();
      notify();
    } catch (error) {
      feedback(
        error instanceof Error ? error.message : "操作失败，现有作品已保留",
      );
    }
  };
  const syncMixer = () =>
    mixer.ensure(arrangement.snapshot().tracks.map((t) => t.id));
  const cancelVoices = () => {
    engine.cancel();
    active.clear();
  };
  const releaseClaim = () => {
    claim?.release();
    claim = null;
    // `readOnly` is deliberately NOT cleared here: a window that lost the take
    // must stay read-only for the rest of its life. Only a successful claim
    // (or a fresh page load) grants write access.
  };
  /** Stop sound and playback without deciding the fate of a take. */
  const halt = () => {
    epoch++;
    transport.stop();
    cancelVoices();
  };
  /** Deliberately abandon the in-progress take (used before loading data). */
  const cancelTake = () => {
    recorder.cancel();
    releaseClaim();
  };
  const settleTake = () => {
    // Close held keys at the current musical beat so the persisted take never
    // contains a note that outlives the moment the user stopped.
    recorder.settle(transport.view(now()).absolute);
  };
  /** Stop playback/sound and abandon any take, without releasing the claim. */
  const bootSettle = () => {
    epoch++;
    transport.stop();
    recorder.cancel();
    releaseClaim();
    cancelVoices();
  };
  const pause = () => {
    epoch++;
    settleTake();
    transport.pause(now());
    cancelVoices();
    dirty = true;
    feedback(
      recorder.snapshot().status === "idle"
        ? "播放已暂停。"
        : "播放已暂停；本次录音进度已保留，可继续或取消。",
    );
    commitDraft("auto");
  };
  const stop = () => {
    // Stop is a deliberate abandon: it returns to the loop start and drops the
    // unfinished take (a pause, or closing the page, preserves it instead).
    epoch++;
    settleTake();
    transport.stop();
    recorder.cancel();
    releaseClaim();
    cancelVoices();
    dirty = true;
    feedback("已停止并回到循环起点；未完成录音已取消，原片段保留。");
    commitDraft("auto");
  };
  const unlock = async () => {
    const context = await engine.unlock();
    if (disposed) return false;
    mixer.attach(context);
    syncMixer();
    engine.route(mixer.channel);
    return true;
  };
  const assembleSession = (): Session => {
    const a = arrangement.snapshot(),
      t = transport.view(now()),
      m = mixer.snapshot();
    return {
      version: 1,
      title: a.title,
      bpm: t.bpm,
      beats: t.beats,
      tracks: a.tracks,
      channels: m.channels,
      master: m.master,
    };
  };
  const draftPayload = (): DraftPayload => {
    const t = transport.view(now());
    // A live take is frozen at the last reliably observed beat; a recovered
    // take is written exactly as-is until the user confirms it.
    const partial = recorder.persistable(t.absolute);
    const exists =
      partial && arrangement.snapshot().tracks.some((x) => x.id === partial.trackId);
    return {
      version: 2,
      revision,
      savedAt: Date.now(),
      session: assembleSession(),
      transport: {
        bpm: t.bpm,
        beats: t.beats,
        // Musical beat only. The audio-clock absolute is never persisted.
        beat: t.absolute,
        running: t.running,
      },
      recorder: exists ? partial : null,
    };
  };
  const commitDraft = (reason: "auto" | "flush" | "lifecycle") => {
    // Never overwrite the pending draft while the user is still deciding, and
    // never write from a window that does not own the take.
    if (recovery || readOnly) return;
    let payload: DraftPayload;
    try {
      // Revision must advance past whatever is already on disk (another tab
      // may have written while this one was idle), so slot fallback ordering
      // never prefers an older draft.
      revision = Math.max(revision + 1, currentRevision() + 1);
      payload = draftPayload();
    } catch (error) {
      saveNotice = {
        kind: "io",
        message: error instanceof Error ? error.message : "草稿生成失败",
        keptRevision: revision || null,
      };
      notify();
      return;
    }
    lastWriteAt = Date.now();
    const written = writeDraft(payload, payload.revision);
    if (written.ok) {
      revision = written.revision;
      if (saveNotice) {
        saveNotice = null;
        feedback("草稿已恢复写入，当前进度已保存。");
      }
      dirty = false;
      lastSavedBeat = payload.transport.beat;
    } else {
      const notice: NonNullable<SaveNotice> = {
        kind: written.reason,
        message: written.message,
        keptRevision: written.keptRevision ?? (revision || null),
      };
      saveNotice = notice;
      message = `${notice.message}（最近可校验版本 rev ${notice.keptRevision ?? "—"}）`;
    }
    notify();
  };
  /**
   * Own the recorder transaction for this window so two windows can never
   * resume the same take. On failure this window becomes read-only.
   */
  const ensureClaim = async (transactionId: string) => {
    if (claim?.transactionId === transactionId) return true;
    // Once a window has lost a take it stays read-only for its lifetime; a
    // later release by the other tab must not let it clobber that work.
    if (readOnly) return false;
    releaseClaim();
    // `claimTake` is the liveness check: Web Locks releases immediately when
    // the owning tab crashes, so a stale lease never blocks recovery.
    const next = await claimTake(transactionId, owner);
    if (disposed) {
      next?.release();
      return false;
    }
    claim = next;
    if (!next) {
      // Another live window owns this take. This one must never write it, even
      // after that window later closes: only a fresh page load can retry.
      readOnly = true;
      return false;
    }
    return true;
  };
  const play = async () => {
    const token = ++epoch;
    try {
      if (!(await unlock()) || token !== epoch) return;
      transport.start(now() + 0.02);
      tick();
      dirty = true;
      notify();
    } catch {
      feedback("声音启动失败，请再次点击播放");
    }
  };
  const tick = () => {
    const time = now(),
      view = transport.view(time);
    const take = recorder.advance(view.absolute);
    if (take)
      guard(() => {
        // Commit happens only with a complete take; if it throws, the previous
        // committed notes stay and the draft keeps the partial.
        arrangement.commit(take.trackId, take.notes);
        releaseClaim();
        dirty = true;
        message = `录制完成 · ${take.notes.length} 个音符`;
      });
    const capture = recorder.snapshot();
    // Only an actively capturing take truncates playback at its end. A
    // recovered-but-unconfirmed take does not advance, so auditioning should
    // still play the whole loop.
    const ceiling =
      capture.status === "recording" || capture.status === "waiting"
        ? capture.start + capture.length
        : Infinity;
    const window = transport.window(time, ceiling);
    if (window)
      scheduleWindow(
        arrangement.forPlayback(),
        window.from,
        window.to,
        view.beats,
        view.bpm,
        window.timeAt,
        (n) => engine.play(n),
      );
  };
  const down = async (id: string, note: NoteInput) => {
    if (active.has(id)) return;
    active.add(id);
    notify();
    try {
      if (!(await unlock()) || !active.has(id)) return;
      const target = arrangement.selected();
      if (!target || target.instrument !== note.instrument) {
        active.delete(id);
        feedback("请先选择对应乐器的轨道");
        return;
      }
      const abs = transport.view(now()).absolute;
      const take = recorder.advance(abs);
      if (take) {
        arrangement.commit(take.trackId, take.notes);
        releaseClaim();
        dirty = true;
      }
      recorder.down(id, note, abs);
      engine.play(
        {
          ...note,
          trackId: target.id,
          duration: note.instrument === "keys" ? 6 : 0.3,
          when: now(),
        },
        id,
      );
    } catch {
      active.delete(id);
      feedback("请点击播放以启用声音");
    }
  };
  const up = (id: string) => {
    if (!active.delete(id)) return;
    recorder.up(id, transport.view(now()).absolute);
    engine.release(id);
    dirty = true;
    notify();
  };
  /** Load a complete session, abandoning any take (never a partial commit). */
  const install = (session: Session) => {
    bootSettle();
    const valid = arrangement.restore(session);
    transport.configure(valid.bpm, valid.beats);
    mixer.restore(valid.channels, valid.master);
    dirty = true;
    notify();
  };
  const applyRecovered = (payload: DraftPayload, fromManual: boolean) => {
    // Do not release the claim here: it was just acquired for this take.
    halt();
    recorder.cancel();
    const valid = arrangement.restore(payload.session);
    // Rebuild the audio anchor at a fresh paused position. The saved musical
    // beat is restored, but playback stays paused so notes from the period the
    // page was closed are never back-filled.
    transport.restore({
      bpm: valid.bpm,
      beats: valid.beats,
      beat: payload.transport.beat,
      running: false,
    });
    mixer.restore(valid.channels, valid.master);
    syncMixer();
    let partial: RecorderDraft | null = null;
    if (payload.recorder && !fromManual) {
      arrangement.select(payload.recorder.trackId);
      if (recorder.restore(payload.recorder)) partial = payload.recorder;
    }
    revision = Math.max(revision, payload.revision);
    dirty = true;
    recovery = null;
    recoverySource = null;
    message = partial
      ? `草稿已恢复并暂停。${partial.notes.length} 个音符待确认，原完整录音仍在轨道上。`
      : "草稿已恢复并暂停。";
    notify();
    // Persist the resumed state under a new revision. A recovered partial is
    // written unchanged by `persistable` until the user confirms it.
    commitDraft("flush");
  };
  const presentRecovery = (
    read: DraftRead,
    fromManual: boolean,
    warning: string | null,
    takenOver: boolean,
  ) => {
    recoverySource = read;
    // Show the original committed clip next to the recovered partial so the
    // user can decide with both in view.
    const originalTrack = read.payload.recorder
      ? read.payload.session.tracks.find(
          (t) => t.id === read.payload.recorder?.trackId,
        )
      : null;
    recovery = {
      summary: draftSummary(read.payload),
      original: originalTrack ? structuredClone(originalTrack.notes) : [],
      draft: read.payload.recorder
        ? structuredClone(read.payload.recorder.notes)
        : [],
      warning,
      takenOver,
      fromManual,
    };
    message = takenOver
      ? "另一个窗口正在接管这段录音；本窗口只读，可稍后处理或关闭该窗口。"
      : "发现可恢复的草稿，请选择恢复或丢弃。";
    notify();
  };
  /**
   * Show the recovery prompt. We deliberately do NOT claim the take here:
   * showing a prompt in a second window must not steal the transaction from a
   * live owner. The claim happens only when the user chooses 恢复.
   */
  const prepareRecovery = (
    read: DraftRead,
    fromManual: boolean,
    warning: string | null,
  ) => {
    presentRecovery(read, fromManual, warning, false);
  };
  const bootstrap = () => {
    const sources = recoverySources();
    manualAvailable = hasManualSession();
    if (sources.draft.draft) {
      const read = sources.draft.draft;
      const payload = read.payload;
      const empty = payload.session.tracks.length === 0 && !payload.recorder;
      if (empty && read.source !== "legacy") {
        // A draft that never saw an edit is not worth prompting about, and it
        // carries no transaction that another window could own.
        clearDraft();
      } else {
        prepareRecovery(read, false, sources.draft.warning);
        return;
      }
    }
    if (sources.draft.warning) {
      // A legacy upgrade failed: keep the originals and say so plainly.
      message = sources.draft.warning;
      saveNotice = {
        kind: "io",
        message: sources.draft.warning,
        keptRevision: null,
      };
      notify();
    }
    if (sources.manual) {
      presentRecovery(
        sources.manual,
        true,
        "检测到旧格式手动存档，可作为草稿恢复；原存档不会改动。",
        false,
      );
      return;
    }
    // A pristine open writes nothing; the first edit creates the draft.
    dirty = false;
    notify();
  };
  const timer = window.setInterval(() => {
    tick();
    const status = recorder.snapshot().status;
    const beat = transport.view(now()).absolute;
    const elapsed = Date.now() - lastWriteAt;
    const interval = saveNotice ? RETRY_WRITE_MS : AUTO_WRITE_MS;
    const moved = Math.abs(beat - lastSavedBeat) >= 0.5;
    const statusChanged = status !== lastStatus;
    // Autosave is throttled: music movement, a take state change, or an
    // explicit dirty flag, at most ~3 writes/s and slower while failing.
    if (
      !recovery &&
      !readOnly &&
      elapsed >= interval &&
      (statusChanged || moved || dirty)
    )
      commitDraft("auto");
    lastStatus = status;
    notify();
  }, 20);
  const leaseTimer = window.setInterval(() => {
    if (claim && !renewLease(owner)) {
      // Lost the lease: stop writing this take and step back to read-only.
      claim = null;
      readOnly = true;
      message = "另一个窗口接管了本次录音，本窗口已停止写入。";
      notify();
    }
  }, 3000);
  const unbind = bindPerformanceInput((id, note) => void down(id, note), up);
  const shortcut = (e: KeyboardEvent) => {
    if (
      e.code === "Space" &&
      !e.repeat &&
      !recovery &&
      !/INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target as HTMLElement).tagName)
    ) {
      e.preventDefault();
      if (transport.view(now()).running) pause();
      else void play();
    }
  };
  const blur = () => {
    for (const id of [...active]) up(id);
  };
  const flushOnExit = () => {
    // Synchronous best-effort commit; a page being torn down still leaves one
    // complete verifiable version behind. `persistable` already represents
    // held keys as notes closed at the last reliable beat without mutating
    // live capture, which matters because `hidden` is often transient.
    if (recovery || readOnly) return;
    if (recorder.snapshot().status !== "idle" || dirty)
      commitDraft("lifecycle");
  };
  const pageHide = () => flushOnExit();
  const visibility = () => {
    if (document.visibilityState === "hidden") flushOnExit();
    else if (transport.view(now()).running) tick();
  };
  const beforeUnload = () => flushOnExit();
  window.addEventListener("keydown", shortcut);
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("beforeunload", beforeUnload);
  document.addEventListener("visibilitychange", visibility);
  bootstrap();
  return {
    view() {
      return {
        transport: transport.view(now()),
        arrangement: arrangement.snapshot(),
        selected: arrangement.selected(),
        recorder: recorder.snapshot(),
        mixer: mixer.snapshot(),
        active: new Set(active),
        message,
        revision,
        saveNotice,
        recovery,
        manualAvailable,
        readOnly,
      };
    },
    play,
    pause,
    stop,
    down: (id: string, n: NoteInput) => void down(id, n),
    up,
    configure(bpm: number, beats: number) {
      halt();
      cancelTake();
      transport.configure(bpm, beats);
      arrangement.resizeLoop(transport.view(now()).beats);
      dirty = true;
      feedback("速度或长度变更：播放回到起点；缩短时移除范围外音符。");
    },
    add(kind: Instrument) {
      guard(() => {
        arrangement.add(kind);
        syncMixer();
        dirty = true;
      });
    },
    select(id: string) {
      if (recorder.snapshot().status !== "idle") return;
      engine.releaseHeld();
      active.clear();
      arrangement.select(id);
      notify();
    },
    remove() {
      guard(() => {
        const selected = arrangement.selected();
        if (selected) {
          halt();
          cancelTake();
          arrangement.remove(selected.id);
          syncMixer();
          dirty = true;
        }
      });
    },
    clear() {
      guard(() => {
        const t = arrangement.selected();
        if (t) {
          halt();
          cancelTake();
          arrangement.clear(t.id);
          dirty = true;
        }
      });
    },
    async record() {
      const selected = arrangement.selected();
      if (!selected || recovery) return;
      const state = recorder.snapshot();
      // Recovered takes must be confirmed, not silently restarted.
      if (state.status === "recovered") {
        feedback("请先确认或丢弃恢复的录音，再开始新的录制。");
        return;
      }
      if (state.status !== "idle") return;
      const token = ++epoch;
      try {
        if (!(await unlock()) || token !== epoch) return;
        const view = transport.view(now());
        if (!view.running) transport.start(now() + 0.02);
        recorder.arm(
          selected.id,
          selected.instrument,
          transport.view(now()).absolute,
          view.beats,
        );
        const armed = recorder.snapshot();
        if (!(await ensureClaim(armed.transactionId))) {
          if (token === epoch) {
            recorder.cancel();
            feedback("另一个窗口正在接管这段录音，本窗口无法开始录制。");
          }
          return;
        }
        dirty = true;
        tick();
        notify();
      } catch {
        feedback("录音启动失败，请重试");
      }
    },
    cancel() {
      cancelTake();
      dirty = true;
      commitDraft("flush");
      feedback("本次录音已取消，之前的片段仍然保留。");
    },
    async confirmRecovered() {
      const state = recorder.snapshot();
      if (state.status !== "recovered") return;
      const ok = await ensureClaim(state.transactionId);
      if (!ok) {
        feedback("无法接管这段录音：另一个窗口仍在使用它。");
        return;
      }
      try {
        if (!(await unlock())) return;
        recorder.confirm();
        // Resume from the recovered musical point with a brand-new audio
        // anchor, so the closed period is never replayed.
        transport.seek(state.resumeAt);
        transport.start(now() + 0.02);
        dirty = true;
        tick();
        commitDraft("flush");
        feedback("已确认恢复的录音，继续录制剩余拍数。");
      } catch {
        feedback("声音启动失败，请再次点击确认");
      }
    },
    discardRecovered() {
      cancelTake();
      dirty = true;
      recovery = null;
      commitDraft("flush");
      feedback("已丢弃恢复的录音草稿；原完整录音保持不变。");
    },
    recoverDraft() {
      if (!recovery || !recoverySource) return;
      const read = recoverySource;
      const fromManual = recovery.fromManual;
      const partial = read.payload.recorder;
      if (!partial) {
        applyRecovered(read.payload, fromManual);
        return;
      }
      // Claim only on an explicit user choice. If another live window owns the
      // take, this window must not resume it.
      void (async () => {
        const ok = await ensureClaim(partial.transactionId);
        if (disposed) return;
        if (!ok) {
          recovery = { ...recovery!, takenOver: true };
          feedback("另一个窗口正在接管这段录音，本窗口无法恢复。");
          return;
        }
        applyRecovered(read.payload, fromManual);
      })();
    },
    discardDraft() {
      // A window that does not own the take must not destroy the transaction;
      // it can only dismiss its own prompt.
      if (readOnly || (recovery?.takenOver ?? false)) {
        recovery = null;
        recoverySource = null;
        feedback("已关闭提示；另一个窗口仍在接管这段录音，草稿未被删除。");
        return;
      }
      // Discard only the draft transaction. Manual saves live on their own key
      // and remain independently loadable via 恢复. Leave the draft store empty
      // so the next open starts pristine; the next edit creates a new draft.
      cancelTake();
      clearDraft();
      recovery = null;
      recoverySource = null;
      dirty = false;
      revision = 0;
      transport.restore({ bpm: 108, beats: 16, beat: 0, running: false });
      feedback("草稿已丢弃；手动存档未被改动，仍可单独恢复。");
    },
    grid(n: number) {
      recorder.grid(n);
      notify();
    },
    volume(id: string, n: number) {
      mixer.volume(id, n);
      dirty = true;
      notify();
    },
    mute(id: string) {
      mixer.mute(id);
      dirty = true;
      notify();
    },
    master(n: number) {
      mixer.master(n);
      dirty = true;
      notify();
    },
    demo() {
      guard(() => {
        install(demoSession());
      });
    },
    save() {
      guard(() => {
        const state = recorder.snapshot();
        if (state.status === "waiting" || state.status === "recording")
          throw new Error("请完成或取消录音后再保存");
        // A recovered take is not part of the arrangement, so a manual save
        // stores the last complete work while the draft keeps the partial.
        writeManualSession(assembleSession());
        manualAvailable = true;
        message = "作品已保存到本机浏览器（草稿与存档各自独立）";
        notify();
      });
    },
    load() {
      guard(() => {
        if (recorder.snapshot().status !== "idle")
          throw new Error("请先确认或丢弃进行中的录音，再恢复手动存档");
        const session = readManualSession();
        install(session);
        manualAvailable = true;
        message = "手动存档已恢复；进行中的草稿仍保留。";
        commitDraft("auto");
      });
    },
    saveDraftNow() {
      commitDraft("flush");
    },
    dispose() {
      // Flush first, while the instance is still fully functional.
      if (recorder.snapshot().status !== "idle" || dirty)
        commitDraft("lifecycle");
      disposed = true;
      epoch++;
      clearInterval(timer);
      clearInterval(leaseTimer);
      releaseClaim();
      unbind();
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
      mixer.dispose();
      engine.dispose();
    },
  };
}
export type Studio = ReturnType<typeof createStudio>;
