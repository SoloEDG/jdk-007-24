export type Instrument = "drums" | "keys";
export type Note = {
  id: string;
  pitch: number;
  beat: number;
  duration: number;
  velocity: number;
};
export type Track = {
  id: string;
  name: string;
  instrument: Instrument;
  color: string;
  notes: Note[];
};
export type Channel = { volume: number; muted: boolean };
export type Session = {
  version: 1;
  title: string;
  bpm: number;
  beats: number;
  tracks: Track[];
  channels: Record<string, Channel>;
  master: number;
};
export type NoteInput = {
  pitch: number;
  velocity: number;
  instrument: Instrument;
};
/**
 * A recording take in progress, described in musical beats relative to the
 * capture window. Persisted so a closed tab can resume without retaking the
 * beats already recorded.
 */
export type RecorderDraft = {
  status: "waiting" | "recording" | "recovered";
  trackId: string;
  instrument: Instrument;
  start: number;
  length: number;
  grid: number;
  notes: Note[];
  /** Absolute musical beat where the last reliable capture stopped. */
  progress: number;
  /** Stable identity of this recording transaction, used to arbitrate tabs. */
  transactionId: string;
};
/** Musical transport position, free of any audio-clock absolute seconds. */
export type TransportSnapshot = {
  bpm: number;
  beats: number;
  /** Absolute musical beat (never audio seconds) at snapshot time. */
  beat: number;
  /** Play state at snapshot time; recovery always re-opens paused. */
  running: boolean;
};
export type ScheduledNote = NoteInput & {
  duration: number;
  when: number;
  trackId: string;
};
export type Listener = () => void;
