import type { Note } from "@/shared/types";
import type { DraftSummary } from "../model/storage";
export type RecoveryView = {
  summary: DraftSummary;
  original: readonly Note[];
  draft: readonly Note[];
  warning: string | null;
  takenOver: boolean;
  fromManual: boolean;
};
export function DraftRecovery({
  view,
  beats,
  recover,
  discard,
}: {
  view: RecoveryView;
  beats: number;
  recover: () => void;
  discard: () => void;
}) {
  const s = view.summary;
  const partial = s.partial;
  const progress = partial
    ? Math.min(
        1,
        Math.max(0, (partial.progress - partial.start) / partial.length),
      )
    : 0;
  return (
    <div className="draft-recovery" role="dialog" aria-modal="true">
      <div className="draft-card">
        <div className="draft-head">
          <span className="draft-badge">
            {view.fromManual ? "旧版存档" : "崩溃恢复草稿"} · rev {s.revision}
          </span>
          <small>{formatTime(s.savedAt)}</small>
        </div>
        <h2>发现上次未完成的工作</h2>
        <p className="draft-sub">
          <strong>{s.title}</strong> · {s.tracks} 条轨道 · {s.bpm} BPM ·{" "}
          {s.beats / 4} 小节
        </p>
        {view.warning && <p className="draft-warning">{view.warning}</p>}
        {partial ? (
          <>
            <div className="draft-partial">
              <div>
                <span>未完成录音 · {partial.trackName}</span>
                <b>{partial.notes} 个音符</b>
              </div>
              <div>
                <span>
                  已录 {(partial.progress - partial.start).toFixed(2)} /{" "}
                  {partial.length} 拍
                </span>
                <b>剩余 {partial.remaining.toFixed(2)} 拍</b>
              </div>
              <div className="draft-progress" aria-hidden="true">
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <small>
                恢复后会先暂停；确认接管后才继续录剩余拍数，关闭期间的音符不会补播。
              </small>
            </div>
            <div className="draft-compare">
              <div>
                <small>原完整片段（{view.original.length} 音符）</small>
                <div className="draft-strip">
                  {view.original.map((n) => (
                    <i
                      key={n.id}
                      className="original"
                      style={{
                        left: `${(n.beat / beats) * 100}%`,
                        width: `${Math.max(0.6, (n.duration / beats) * 100)}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <small>恢复草稿（{view.draft.length} 音符）</small>
                <div className="draft-strip">
                  {view.draft.map((n) => (
                    <i
                      key={n.id}
                      className="partial"
                      style={{
                        left: `${(n.beat / beats) * 100}%`,
                        width: `${Math.max(0.6, (n.duration / beats) * 100)}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="draft-partial">
            <div>
              <span>已完成作品与混音状态</span>
              <b>无进行中录音</b>
            </div>
            <small>恢复后会先暂停在关闭时的音乐位置。</small>
          </div>
        )}
        {view.takenOver && (
          <p className="draft-warning">
            另一个窗口正在接管这段录音。本窗口只能丢弃草稿，或关闭后重试。
          </p>
        )}
        <div className="draft-actions">
          <button className="primary" disabled={view.takenOver} onClick={recover}>
            {view.fromManual ? "恢复存档内容" : "恢复并暂停"}
          </button>
          <button onClick={discard}>丢弃草稿</button>
        </div>
        <small className="draft-note">
          丢弃只清除自动草稿；手动存档独立保存，仍可在顶部“恢复”中载入。
        </small>
      </div>
    </div>
  );
}
function formatTime(ms: number) {
  if (!ms) return "时间未知";
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "时间未知";
  }
}
