/**
 * Minimal localStorage + Web Locks shim so the persistence modules can be
 * exercised under Node without a browser. This script lives outside `src` and
 * is only for verification; it is not part of the app bundle.
 */
class MemoryStorage {
  constructor(bytes = 5_000_000) {
    this.map = new Map();
    this.capacity = bytes;
    this.failNext = 0;
  }
  #size(extraKey = null, extraValue = null) {
    let total = 0;
    for (const [k, v] of this.map) total += k.length + v.length;
    if (extraKey != null) total += String(extraKey).length + String(extraValue).length;
    return total;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.failNext > 0) {
      this.failNext--;
      const error = new DOMException("quota", "QuotaExceededError");
      throw error;
    }
    const next = String(value);
    const existing = this.map.has(key) ? key.length + this.map.get(key).length : 0;
    if (this.#size() - existing + key.length + next.length > this.capacity)
      throw new DOMException("quota exceeded", "QuotaExceededError");
    this.map.set(key, next);
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});
if (!globalThis.DOMException) {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name;
    }
  };
}
const locks = new Map();
Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: {
    async request(name, options, callback) {
      if (locks.has(name)) {
        if (options?.ifAvailable) return callback(null);
        await locks.get(name);
      }
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      locks.set(name, held);
      try {
        // Honour the exact contract used by the app: the callback keeps the
        // lock until the promise it returns settles.
        return await callback({ name });
      } finally {
        locks.delete(name);
        release();
      }
    },
  },
});
if (!globalThis.crypto?.randomUUID) {
  const { webcrypto } = await import("node:crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}
export { storage, locks };
