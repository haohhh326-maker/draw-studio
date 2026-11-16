import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetUrlCache } from "../src/assets/asset-url-cache";

const blob = (size: number) => new Blob([new Uint8Array(size)]);
const load = (size = 1) => vi.fn(async () => blob(size));

beforeEach(() => {
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++next}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("bounded reusable asset URLs", () => {
  it("reuses an unmounted preview without reloading its blob", async () => {
    const cache = new AssetUrlCache(), read = load();
    const first = await cache.acquire("preview", read);
    first.release();
    const second = await cache.acquire("preview", read);
    expect(second.url).toBe(first.url);
    expect(read).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.release();
  });

  it("shares a pending blob read across consumers and waits for the last release", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 5, maxIdleEntries: 0 });
    let finish!: (value: Blob) => void;
    const read = vi.fn(() => new Promise<Blob>(resolve => { finish = resolve; }));
    const first = cache.acquire("pending", read), second = cache.acquire("pending", read);
    await Promise.resolve(); finish(blob(1));
    const [a, b] = await Promise.all([first, second]);
    expect(read).toHaveBeenCalledOnce();
    expect(a.url).toBe(b.url);
    a.release(); a.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    b.release(); b.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a.url);
  });

  it("evicts the least recently used idle URL at the entry limit", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 100, maxIdleEntries: 2 });
    const readA = load(), readB = load();
    const a = await cache.acquire("a", readA); a.release();
    const b = await cache.acquire("b", readB); b.release();
    const reusedA = await cache.acquire("a", readA); reusedA.release();
    const c = await cache.acquire("c", load()); c.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(b.url);
    const newB = await cache.acquire("b", readB);
    expect(newB.url).not.toBe(b.url);
    expect(readB).toHaveBeenCalledTimes(2);
    newB.release();
  });

  it("counts actual blob bytes and retains entries exactly at the byte boundary", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 5, maxIdleEntries: 10 });
    const a = await cache.acquire("a", load(3)); a.release();
    const b = await cache.acquire("b", load(2)); b.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    const c = await cache.acquire("c", load(1)); c.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a.url);
  });

  it("never revokes active URLs when idle previews need eviction", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 2, maxIdleEntries: 1 });
    const activeRead = load(20), active = await cache.acquire("active", activeRead);
    const a = await cache.acquire("a", load(2)); a.release();
    const b = await cache.acquire("b", load(2)); b.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a.url);
    const secondActive = await cache.acquire("active", activeRead);
    expect(secondActive.url).toBe(active.url);
    expect(activeRead).toHaveBeenCalledOnce();
    active.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(active.url);
    secondActive.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(active.url);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(b.url);
  });

  it("releases an oversized idle video without discarding smaller idle previews", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 5, maxIdleEntries: 10 });
    const smallRead = load(2), small = await cache.acquire("small", smallRead); small.release();
    const largeRead = load(6), large = await cache.acquire("large", largeRead); large.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(large.url);
    const again = await cache.acquire("small", smallRead);
    expect(again.url).toBe(small.url);
    expect(smallRead).toHaveBeenCalledOnce();
    again.release();
  });

  it("does not let duplicate releases revoke a later acquisition", async () => {
    const cache = new AssetUrlCache({ maxIdleBytes: 5, maxIdleEntries: 1 });
    const read = load(), first = await cache.acquire("a", read); first.release();
    const active = await cache.acquire("a", read);
    first.release();
    const b = await cache.acquire("b", load()); b.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(active.url);
    active.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(b.url);
  });

  it("removes failed pending loads so concurrent callers can retry", async () => {
    const cache = new AssetUrlCache();
    const failure = new Error("read failed");
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(blob(2));
    const results = await Promise.allSettled([cache.acquire("a", read), cache.acquire("a", read)]);
    expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(read).toHaveBeenCalledOnce();
    const recovered = await cache.acquire("a", read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    recovered.release();
  });

  it("also recovers from a synchronous loader exception and object URL allocation failure", async () => {
    const cache = new AssetUrlCache();
    await expect(cache.acquire("a", () => { throw new Error("sync read"); })).rejects.toThrow("sync read");
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error("allocation"); });
    await expect(cache.acquire("a", load())).rejects.toThrow("allocation");
    const recovered = await cache.acquire("a", load());
    expect(recovered.url).toBe("blob:preview-1");
    recovered.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("keeps original and thumbnail keys separate", async () => {
    const cache = new AssetUrlCache(), originalRead = load(4), previewRead = load(1);
    const original = await cache.acquire("asset:full", originalRead), preview = await cache.acquire("asset:preview", previewRead);
    expect(original.url).not.toBe(preview.url);
    expect(originalRead).toHaveBeenCalledOnce(); expect(previewRead).toHaveBeenCalledOnce();
    original.release(); preview.release();
  });

  it("reuses a wide canvas of small previews before evicting the oldest idle URL", async () => {
    const cache = new AssetUrlCache();
    const urls: string[] = [];
    for (let i = 0; i < 129; i++) {
      const item = await cache.acquire(String(i), load()); urls.push(item.url); item.release();
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(urls[0]);
  });
});
