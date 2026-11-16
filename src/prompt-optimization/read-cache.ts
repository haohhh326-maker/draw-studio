type PendingRead<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
  value?: T;
};

const cancelledRead = () => new DOMException("The operation was aborted.", "AbortError");

/** Page-session cache. Each subscriber owns its cancellation, not the shared request. */
export function createOptimizationReadCache<T>(limit = 24) {
  const entries = new Map<string, PendingRead<T>>();
  const trim = () => {
    while (entries.size > limit) entries.delete(entries.keys().next().value!);
  };
  return {
    clear() { entries.clear(); },
    prime(key: string, value: T) {
      const copy = structuredClone(value);
      entries.set(key, { controller: new AbortController(), promise: Promise.resolve(copy), subscribers: 0, settled: true, value: copy });
      trim();
    },
    read(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, refresh = false, accept: (value: T) => boolean = () => true): Promise<T> {
      if (signal?.aborted) return Promise.reject(cancelledRead());
      let entry = refresh ? undefined : entries.get(key);
      if (entry?.settled) {
        entries.delete(key); entries.set(key, entry);
        return Promise.resolve(structuredClone(entry.value!));
      }
      if (!entry) {
        const controller = new AbortController();
        const pending: PendingRead<T> = { controller, promise: undefined!, subscribers: 0, settled: false };
        pending.promise = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw cancelledRead();
          return load(controller.signal);
        }).then(value => {
          if (controller.signal.aborted) throw cancelledRead();
          pending.settled = true;
          pending.value = structuredClone(value);
          if (!accept(value) && entries.get(key) === pending) entries.delete(key);
          return value;
        }, cause => {
          pending.settled = true;
          if (entries.get(key) === pending) entries.delete(key);
          throw cause;
        });
        entry = pending; entries.set(key, entry); trim();
      }
      const shared = entry;
      shared.subscribers++;
      return new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = () => {
          if (done) return false;
          done = true; shared.subscribers--; signal?.removeEventListener("abort", abort);
          return true;
        };
        const abort = () => {
          if (!finish()) return;
          if (!shared.settled && shared.subscribers === 0) {
            if (entries.get(key) === shared) entries.delete(key);
            shared.controller.abort();
          }
          reject(cancelledRead());
        };
        signal?.addEventListener("abort", abort, { once: true });
        shared.promise.then(value => { if (finish()) resolve(structuredClone(value)); }, cause => { if (finish()) reject(cause); });
      });
    },
  };
}
