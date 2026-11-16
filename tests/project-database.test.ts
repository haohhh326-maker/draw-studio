import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDBPDatabase } from "idb";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("idb", () => ({ openDB: mocks.open }));

type OpenCallbacks = { upgrade: (database: IDBPDatabase) => void; blocking: () => void; terminated: () => void };
const database = () => ({ close: vi.fn(), createObjectStore: vi.fn() }) as unknown as IDBPDatabase;
const callbacks = (index = 0): OpenCallbacks => mocks.open.mock.calls[index][2];

beforeEach(() => { vi.resetModules(); mocks.open.mockReset(); });

describe("shared project IndexedDB connection", () => {
  it("shares one pending connection and reuses it after opening", async () => {
    let resolve!: (value: IDBPDatabase) => void;
    const value = database();
    mocks.open.mockImplementation(() => new Promise<IDBPDatabase>(done => { resolve = done; }));
    const { projectDatabase } = await import("../src/projects/database");
    const first = projectDatabase(), second = projectDatabase();
    expect(first).toBe(second);
    expect(mocks.open).toHaveBeenCalledOnce();
    resolve(value);
    expect(await first).toBe(value);
    expect(await projectDatabase()).toBe(value);
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(value.close).not.toHaveBeenCalled();
  });

  it("retains the existing database name, version and stores", async () => {
    const value = database(); mocks.open.mockResolvedValue(value);
    const { projectDatabase } = await import("../src/projects/database");
    await projectDatabase(); callbacks().upgrade(value);
    expect(mocks.open).toHaveBeenCalledWith("clearframe-canvas", 1, expect.any(Object));
    expect(value.createObjectStore).toHaveBeenNthCalledWith(1, "records");
    expect(value.createObjectStore).toHaveBeenNthCalledWith(2, "assets");
  });

  it("allows retry after an opening failure", async () => {
    const failure = new Error("database temporarily unavailable"), value = database();
    mocks.open.mockRejectedValueOnce(failure).mockResolvedValueOnce(value);
    const { projectDatabase } = await import("../src/projects/database");
    await expect(projectDatabase()).rejects.toBe(failure);
    expect(await projectDatabase()).toBe(value);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });

  it.each(["blocking", "terminated"] as const)("closes and replaces a connection after %s", async event => {
    const previous = database(), replacement = database();
    mocks.open.mockResolvedValueOnce(previous).mockResolvedValueOnce(replacement);
    const { projectDatabase } = await import("../src/projects/database");
    await projectDatabase(); callbacks()[event]();
    expect(previous.close).toHaveBeenCalledOnce();
    expect(await projectDatabase()).toBe(replacement);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    callbacks()[event]();
    expect(await projectDatabase()).toBe(replacement);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("an old failed open cannot evict a replacement started after invalidation", async () => {
    let reject!: (error: Error) => void;
    const replacement = database();
    mocks.open.mockImplementationOnce(() => new Promise<IDBPDatabase>((_, fail) => { reject = fail; })).mockResolvedValueOnce(replacement);
    const { projectDatabase } = await import("../src/projects/database");
    const old = projectDatabase(); callbacks().terminated();
    expect(await projectDatabase()).toBe(replacement);
    const rejected = expect(old).rejects.toThrow("old connection failed");
    reject(new Error("old connection failed")); await rejected;
    expect(await projectDatabase()).toBe(replacement);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
