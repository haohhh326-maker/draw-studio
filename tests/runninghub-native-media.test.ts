import { describe, expect, it, vi } from "vitest";
import { prepareNativeRunningHubMedia } from "../src/runninghub/native-media";
import type { ApiWorkflow, UploadedInput } from "../src/types";

const uploaded: UploadedInput = { name: "server.mp4", subfolder: "job", inputName: "job/server.mp4", type: "input" };
const graph = (): ApiWorkflow => ({
  "28": { class_type: "VHS_LoadVideoPath", inputs: { video: "input/job/server.mp4", force_rate: 24, custom_width: 512, custom_height: 0, frame_load_cap: 1, skip_first_frames: 0, select_every_nth: 1, format: "H3" } },
  "30": { class_type: "SaveImage", inputs: { images: ["28", 0], filename_prefix: "result" } },
});
const contract = () => ({ input: { required: Object.fromEntries(Object.keys(graph()["28"].inputs).filter(k => k !== "format").map(k => [k, [k === "video" ? ["unrelated.mp4"] : "INT", {}]])), optional: { format: ["STRING"] } }, output: ["IMAGE", "INT", "AUDIO", "VHS_VIDEOINFO"] });
const reader = () => vi.fn(async (type: string) => ({ [type]: contract() }));

describe("RunningHub native uploaded video references", () => {
  it("uses the upload loader with the exact server handle and retains frames, sizing and connections", async () => {
    const source = graph(), before = structuredClone(source), read = reader();
    const result = await prepareNativeRunningHubMedia(source, [uploaded], read);
    expect(result["28"]).toEqual({ ...before["28"], class_type: "VHS_LoadVideo", inputs: { ...before["28"].inputs, video: "job/server.mp4" } });
    expect(result["30"]).toEqual(before["30"]); expect(source).toEqual(before);
    expect(read.mock.calls.map(([type]) => type)).toEqual(["VHS_LoadVideoPath", "VHS_LoadVideo"]);
  });
  it("also handles dynamically added loaders but reads each node definition only once", async () => {
    const source = graph(); source["300"] = structuredClone(source["28"]);
    const read = reader(), result = await prepareNativeRunningHubMedia(source, [uploaded], read);
    expect(result["300"].class_type).toBe("VHS_LoadVideo"); expect(read).toHaveBeenCalledTimes(2);
  });
  it("falls back once to the complete native catalog when per-class replies are empty", async () => {
    const source = graph(), before = structuredClone(source);
    const read = vi.fn(async () => ({}));
    const catalog = vi.fn(async () => ({ VHS_LoadVideoPath: contract(), VHS_LoadVideo: contract() }));
    const result = await prepareNativeRunningHubMedia(source, [uploaded], read, catalog);
    expect(result["28"].class_type).toBe("VHS_LoadVideo");
    expect(result["28"].inputs.video).toBe(uploaded.inputName);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(source).toEqual(before);
  });
  it.each([404, 405, 501])("uses the full catalog for an unsupported per-class endpoint (%s)", async status => {
    const read = vi.fn(async () => { throw Object.assign(new Error("unsupported endpoint"), { status }); });
    const catalog = vi.fn(async () => ({ VHS_LoadVideoPath: contract(), VHS_LoadVideo: contract() }));
    const result = await prepareNativeRunningHubMedia(graph(), [uploaded], read, catalog);
    expect(result["28"].class_type).toBe("VHS_LoadVideo");
    expect(catalog).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 502])("preserves actual per-class request failure (%s)", async status => {
    const failure = Object.assign(new Error("request failed"), { status });
    const read = vi.fn(async () => { throw failure; }), catalog = vi.fn();
    await expect(prepareNativeRunningHubMedia(graph(), [uploaded], read, catalog)).rejects.toBe(failure);
    expect(catalog).not.toHaveBeenCalled();
  });
  it("does not guess a loader when it is absent from both catalogs", async () => {
    await expect(prepareNativeRunningHubMedia(graph(), [uploaded], async () => ({}), async () => ({})))
      .rejects.toThrow("未提供视频上传加载节点定义");
  });
  it("still validates real output contracts supplied by the full catalog", async () => {
    const incompatible = contract(); incompatible.output.reverse();
    await expect(prepareNativeRunningHubMedia(graph(), [uploaded], async () => ({}), async () => ({
      VHS_LoadVideoPath: contract(), VHS_LoadVideo: incompatible,
    }))).rejects.toThrow("端口不兼容");
  });
  it("also adapts legacy mappings that pass the uploaded handle without an input prefix", async () => {
    const source = graph(); source["28"].inputs.video = uploaded.inputName;
    const result = await prepareNativeRunningHubMedia(source, [uploaded], reader());
    expect(result["28"].class_type).toBe("VHS_LoadVideo");
    expect(result["28"].inputs.video).toBe(uploaded.inputName);
  });
  it.each(["https://cdn.example/video.mp4", "/workspace/original.mp4", "input/unrelated.mp4"])("does not rewrite authored external or unrelated path %s", async video => {
    const source = graph(); source["28"].inputs.video = video;
    const read = reader(); expect(await prepareNativeRunningHubMedia(source, [uploaded], read)).toBe(source); expect(read).not.toHaveBeenCalled();
  });
  it("does not rewrite linked values or already-uploadable loaders", async () => {
    const source = graph(); source["28"].inputs.video = ["1", 0];
    const read = reader(); expect(await prepareNativeRunningHubMedia(source, [uploaded], read)).toBe(source);
    source["28"].class_type = "VHS_LoadVideo"; source["28"].inputs.video = "job/server.mp4";
    expect(await prepareNativeRunningHubMedia(source, [uploaded], read)).toBe(source); expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "output", "required", "unknown"])("stops before submission for incompatible %s definitions", async change => {
    const read = async (type: string) => {
      if (type.endsWith("Path")) return { [type]: contract() };
      if (change === "missing") return {};
      const value = contract();
      if (change === "output") value.output.reverse();
      if (change === "required") value.input.required.new_required = ["STRING"];
      if (change === "unknown") delete value.input.required.force_rate;
      return { [type]: value };
    };
    await expect(prepareNativeRunningHubMedia(graph(), [uploaded], read)).rejects.toThrow("未提交任务");
  });
});
