type UrlEntry = { refs: number; size: number; promise: Promise<string>; url?: string };
type CacheLimits = { maxIdleBytes: number; maxIdleEntries: number };

const defaultLimits: CacheLimits = { maxIdleBytes: 64 * 1024 * 1024, maxIdleEntries: 128 };

/** Keep recently unmounted previews reusable without retaining an unbounded set
 * of media blobs. Only unreferenced URLs count toward, and can leave, the LRU. */
export class AssetUrlCache {
  private readonly entries = new Map<string, UrlEntry>();
  private readonly idle = new Map<string, UrlEntry>();
  private idleBytes = 0;

  constructor(private readonly limits: CacheLimits = defaultLimits) {}

  private removeIdle(key: string, entry: UrlEntry) {
    if (this.idle.get(key) !== entry) return;
    this.idle.delete(key);
    this.idleBytes -= entry.size;
  }

  private evict(key: string, entry: UrlEntry) {
    if (entry.refs !== 0 || this.entries.get(key) !== entry) return;
    this.removeIdle(key, entry);
    this.entries.delete(key);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }

  private retainIdle(key: string, entry: UrlEntry) {
    if (this.entries.get(key) !== entry) return;
    // A single oversized video should not evict all small reusable previews.
    if (entry.size > this.limits.maxIdleBytes || this.limits.maxIdleEntries <= 0) {
      this.evict(key, entry);
      return;
    }
    this.idle.set(key, entry);
    this.idleBytes += entry.size;
    while (this.idle.size > this.limits.maxIdleEntries || this.idleBytes > this.limits.maxIdleBytes) {
      const oldest = this.idle.entries().next().value;
      if (!oldest) break;
      this.evict(...oldest);
    }
  }

  async acquire(key: string, loadBlob: () => Promise<Blob>) {
    let entry = this.entries.get(key);
    if (!entry) {
      const created: UrlEntry = { refs: 0, size: 0, promise: Promise.resolve("") };
      // Defer loading until the entry is registered, including synchronous throws.
      created.promise = Promise.resolve().then(loadBlob).then(blob => {
        const url = URL.createObjectURL(blob);
        created.size = blob.size;
        created.url = url;
        return url;
      });
      this.entries.set(key, created);
      entry = created;
    }
    this.removeIdle(key, entry);
    entry.refs++;
    try {
      const url = await entry.promise;
      let released = false;
      return {
        url,
        release: () => {
          if (released) return;
          released = true;
          if (--entry.refs === 0) this.retainIdle(key, entry);
        },
      };
    } catch (error) {
      if (--entry.refs === 0) this.evict(key, entry);
      throw error;
    }
  }
}
