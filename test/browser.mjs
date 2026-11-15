import "./env.mjs";
/**
 * Browser shims for integration-testing the studio: timers, DOM events and a
 * silent WebAudio graph. Audio is irrelevant to recovery semantics, so voices
 * are no-ops that still advance `currentTime` deterministically.
 */
const listeners = new Map();
const win = {
  addEventListener: (type, fn) => {
    if (!listeners.has(`w:${type}`)) listeners.set(`w:${type}`, new Set());
    listeners.get(`w:${type}`).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(`w:${type}`)?.delete(fn),
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
const doc = {
  visibilityState: "visible",
  addEventListener: (type, fn) => {
    if (!listeners.has(`d:${type}`)) listeners.set(`d:${type}`, new Set());
    listeners.get(`d:${type}`).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(`d:${type}`)?.delete(fn),
};
const audio = { currentTime: 0 };
class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.destination = { connect() {} };
  }
  get state() {
    return this._state ?? "running";
  }
  set state(v) {
    this._state = v;
  }
  async resume() {}
  async close() {}
  createOscillator() {
    return {
      type: "sine",
      frequency: params(),
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    };
  }
  createBiquadFilter() {
    return { type: "highpass", frequency: params(), connect() {}, disconnect() {} };
  }
  createBuffer(channels, length) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {} };
  }
  createGain() {
    return {
      gain: params(),
      connect() {},
      disconnect() {},
    };
  }
}
const params = () => ({
  value: 0,
  setValueAtTime() {},
  exponentialRampToValueAtTime() {},
  linearRampToValueAtTime() {},
  cancelScheduledValues() {},
});
Object.defineProperty(FakeAudioContext.prototype, "sampleRate", {
  configurable: true,
  get() {
    return 44100;
  },
});
Object.defineProperty(FakeAudioContext.prototype, "currentTime", {
  configurable: true,
  get() {
    return audio.currentTime;
  },
});
globalThis.window = win;
globalThis.document = doc;
globalThis.AudioContext = FakeAudioContext;
/** Advance the shared audio clock the way a running context would. */
export const tickAudio = (seconds) => {
  audio.currentTime += seconds;
};
export const fireWindow = (type, event = {}) => {
  for (const fn of listeners.get(`w:${type}`) ?? []) fn(event);
};
export const fireDocument = (type, event = {}) => {
  for (const fn of listeners.get(`d:${type}`) ?? []) fn(event);
};
export const setVisibility = (state) => {
  doc.visibilityState = state;
};
export const listenerCount = () => listeners.size;
