export function RecoveredTake({
  notes,
  remaining,
  takenOver,
  confirm,
  discard,
}: {
  notes: number;
  remaining: number;
  takenOver: boolean;
  confirm: () => void;
  discard: () => void;
}) {
  return (
    <div className="recovered-take" role="status">
      <div className="recovered-line">
        <span className="red-dot" />
        已恢复 {notes} 个音符 · 暂停中 · 还需录 {remaining.toFixed(2)} 拍
      </div>
      <div className="recovered-actions">
        <button disabled={takenOver} onClick={confirm}>
          {takenOver ? "另一窗口接管中" : "确认并继续录制"}
        </button>
        <button onClick={discard}>丢弃草稿</button>
      </div>
      <small>
        确认后从恢复位置继续，不会补播关闭期间的音符；丢弃只影响本次草稿。
      </small>
    </div>
  );
}
