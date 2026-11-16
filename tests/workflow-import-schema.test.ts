import { afterEach, beforeEach, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: vi.fn(async (key: string) => records.get(key)),
  writeRecord: vi.fn(async (key: string, value: unknown) => { records.set(key, value); }),
}));
import { loadImportSchema } from "../src/workflow/import-schema";
import { defaultConnection } from "../src/workflow/catalog";
import { writeRecord } from "../src/projects/storage";
const connection = { ...defaultConnection, baseUrl: "https://engine.example/comfy", token: "private-test-token" };
const info = { CustomNode: { input: { required: { prompt: ["STRING"] } }, output: ["STRING"] } };
beforeEach(() => { records.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it("imports without an engine address or usable address without requesting a second file", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(await loadImportSchema({ ...connection, baseUrl: "" }, new AbortController().signal)).toEqual({ warnings: [] });
  expect((await loadImportSchema({ ...connection, baseUrl: "invalid" }, new AbortController().signal)).warnings[0]).toContain("文件自身");
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses the same engine's cached definitions during an outage without persisting a credential", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(info))));
  expect(await loadImportSchema(connection, new AbortController().signal)).toEqual({ info, warnings: [] });
  expect(records.size).toBe(1);
  expect(JSON.stringify([...records])).not.toContain(connection.token);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const result = await loadImportSchema(connection, new AbortController().signal);
  expect(result.info).toEqual(info); expect(result.warnings.join(" ")).toContain("此前读取");
  expect(result.warnings.join(" ")).toContain("导入时重新读取");
  expect(result.warnings.join(" ")).not.toContain("生成时");
});

it("never reuses definitions across different engine addresses or credentials", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(info))));
  await loadImportSchema(connection, new AbortController().signal);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  expect((await loadImportSchema({ ...connection, baseUrl: "https://other-engine.example" }, new AbortController().signal)).info).toBeUndefined();
  expect((await loadImportSchema({ ...connection, token: "different-identity" }, new AbortController().signal)).info).toBeUndefined();
});

it("does not turn cancelled import work into an offline fallback", async () => {
  const controller = new AbortController(); controller.abort();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
  await expect(loadImportSchema(connection, controller.signal)).rejects.toThrow();
});

it("keeps live definitions usable when cache storage fails, and rejects malformed node responses", async () => {
  vi.mocked(writeRecord).mockRejectedValueOnce(new Error("Storage full"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(info))));
  expect((await loadImportSchema(connection, new AbortController().signal)).info).toEqual(info);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  expect((await loadImportSchema(connection, new AbortController().signal)).info).toBeUndefined();
});


it.each([{ error: "not authenticated" }, { code: 503, message: "starting" }, { Broken: { input: [] } }])(
  "rejects successful HTTP responses that are not node schemas: %j", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload))));
    const result = await loadImportSchema(connection, new AbortController().signal);
    expect(result.info).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("不是有效节点定义");
    expect(records.size).toBe(0);
  },
);

it("retains the last valid cache when a proxy returns an error object with HTTP 200", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(info))));
  await loadImportSchema(connection, new AbortController().signal);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }))));
  const result = await loadImportSchema(connection, new AbortController().signal);
  expect(result.info).toEqual(info);
  expect(result.warnings).toHaveLength(2);
  expect([...records.values()]).toEqual([expect.objectContaining({ info })]);
});
