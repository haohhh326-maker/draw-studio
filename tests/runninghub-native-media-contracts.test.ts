import { describe, expect, it } from "vitest";
import { prepareNativeRunningHubMedia } from "../src/runninghub/native-media";
import type { ApiWorkflow, UploadedInput } from "../src/types";

const uploaded: UploadedInput = { name: "test.mp4", subfolder: "job", inputName: "job/test.mp4", type: "input" };
const sizeOptions = ["Disabled", "Custom Height", "Custom Width", "Custom", "256x?", "?x256", "256x256", "512x?", "?x512", "512x512"];
type Contract = { input: { required: Record<string, unknown>; optional: Record<string, unknown>; hidden: Record<string, unknown> }; output: string[]; output_is_list: boolean[] };

// Reduced from the RunningHub native object_info catalog captured on 2026-10-29.
// Unlike the older synthetic fixture, Path and Upload intentionally use different
// required inputs, force_rate types and widget metadata.
function contracts(ffmpeg = false): Record<string, Contract> {
  const type = ffmpeg ? "VHS_LoadVideoFFmpeg" : "VHS_LoadVideo";
  const path: Contract = {
    input: {
      required: {
        video: ["STRING", { placeholder: "X://insert/path/here.mp4" }],
        force_rate: ["FLOAT", { default: 0, min: 0, max: 60, step: 1, disable: 0 }],
        custom_width: ["INT", { default: 0, min: 0, max: 8192, disable: 0 }],
        custom_height: ["INT", { default: 0, min: 0, max: 8192, disable: 0 }],
        frame_load_cap: ["INT", { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, disable: 0 }],
        ...(ffmpeg ? { start_time: ["FLOAT", { default: 0, min: 0, step: 0.001 }] } : {
          skip_first_frames: ["INT", { default: 0, min: 0, step: 1 }],
          select_every_nth: ["INT", { default: 1, min: 1, step: 1 }],
        }),
      },
      optional: {
        meta_batch: ["VHS_BatchManager"], vae: ["VAE"],
        format: [["None", "AnimateDiff", "Mochi", "LTXV", "Hunyuan", "Cosmos", "Wan"], { default: "AnimateDiff" }],
      },
      hidden: { force_size: "STRING", unique_id: "UNIQUE_ID" },
    },
    output: ["IMAGE", ffmpeg ? "MASK" : "INT", "AUDIO", "VHS_VIDEOINFO"],
    output_is_list: [false, false, false, false],
  };
  const upload = structuredClone(path);
  Object.assign(upload.input.required, {
    video: ["STRING", { default: "None" }],
    force_rate: ["INT", { default: 0, min: 0, max: 60, step: 1 }],
    force_size: [[...sizeOptions]],
    custom_width: ["INT", { default: 0, min: 0, max: 8192, step: 8 }],
    custom_height: ["INT", { default: 0, min: 0, max: 8192, step: 8 }],
  });
  if (ffmpeg) upload.input.required.start_time = ["FLOAT", { default: 0, min: 0, step: 1 }];
  return { [type + "Path"]: path, [type]: upload };
}

function workflow(ffmpeg = false): ApiWorkflow {
  return {
    "1": {
      class_type: ffmpeg ? "VHS_LoadVideoFFmpegPath" : "VHS_LoadVideoPath",
      inputs: {
        video: "input/job/test.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0,
        ...(ffmpeg ? { start_time: 1.25 } : { skip_first_frames: 0, select_every_nth: 1 }),
        format: "AnimateDiff", meta_batch: ["2", 0], vae: ["3", 0],
      },
    },
    "2": { class_type: "VHS_BatchManager", inputs: { frames_per_batch: 16 } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "test.safetensors" } },
    "4": { class_type: "VideoDepthAnything", inputs: { images: ["1", 0], resolution: 704 } },
    "5": { class_type: "VHS_VideoInfo", inputs: { video_info: ["1", 3] } },
    "6": { class_type: "VHS_VideoCombine", inputs: { images: ["4", 0], audio: ["1", 2], frame_rate: ["5", 0] } },
  };
}
const reader = (catalog: Record<string, Contract>) => async (type: string) => ({ [type]: catalog[type] });

describe("RunningHub VHS mixed-version upload contracts", () => {
  it.each([
    [0, 0, "Disabled"], [704, 0, "Custom Width"], [0, 480, "Custom Height"], [704, 480, "Custom"],
  ] as const)("preserves authored sizing %s x %s using %s", async (width, height, mode) => {
    const source = workflow();
    Object.assign(source["1"].inputs, { custom_width: width, custom_height: height });
    const before = structuredClone(source);
    const result = await prepareNativeRunningHubMedia(source, [uploaded], reader(contracts()));
    expect(result).toEqual({ ...before, "1": { ...before["1"], class_type: "VHS_LoadVideo", inputs: {
      ...before["1"].inputs, video: uploaded.inputName, force_size: mode,
    } } });
    expect(source).toEqual(before);
  });

  it("handles FFmpeg's matching mask output while preserving fractional start time and all links", async () => {
    const source = workflow(true), before = structuredClone(source);
    const result = await prepareNativeRunningHubMedia(source, [uploaded], reader(contracts(true)));
    expect(result).toEqual({ ...before, "1": { ...before["1"], class_type: "VHS_LoadVideoFFmpeg", inputs: {
      ...before["1"].inputs, video: uploaded.inputName, force_size: "Disabled",
    } } });
    expect(result["1"].inputs.start_time).toBe(1.25);
    expect(source).toEqual(before);
  });

  it.each(["512x512", "Custom Height"])("retains explicit legacy size mode %s instead of deriving a replacement", async mode => {
    const source = workflow();
    Object.assign(source["1"].inputs, { custom_width: 704, custom_height: 480, force_size: mode });
    const before = structuredClone(source);
    const result = await prepareNativeRunningHubMedia(source, [uploaded], reader(contracts()));
    expect(result["1"].inputs).toEqual({ ...before["1"].inputs, video: uploaded.inputName });
    expect(source).toEqual(before);
  });

  it("still rejects a genuinely missing required field even if the schema provides a default", async () => {
    const source = workflow(), before = structuredClone(source), catalog = contracts();
    catalog.VHS_LoadVideo.input.required.future_required = ["INT", { default: 1 }];
    await expect(prepareNativeRunningHubMedia(source, [uploaded], reader(catalog))).rejects.toThrow("未提交任务");
    expect(source).toEqual(before);
  });

  it("does not silently disable resizing when the upload enum lacks the required mode", async () => {
    const source = workflow(), catalog = contracts();
    source["1"].inputs.custom_width = 704;
    catalog.VHS_LoadVideo.input.required.force_size = [["Disabled", "Custom Height"]];
    await expect(prepareNativeRunningHubMedia(source, [uploaded], reader(catalog))).rejects.toThrow("未提交任务");
  });

  it("does not guess a size selector when the destination offers no supported enum", async () => {
    const catalog = contracts(); catalog.VHS_LoadVideo.input.required.force_size = ["STRING"];
    await expect(prepareNativeRunningHubMedia(workflow(), [uploaded], reader(catalog))).rejects.toThrow("未提交任务");
  });

  it("rejects an explicit size mode that the upload loader does not support", async () => {
    const source = workflow(); source["1"].inputs.force_size = "unsupported-resize-mode";
    await expect(prepareNativeRunningHubMedia(source, [uploaded], reader(contracts()))).rejects.toThrow("未提交任务");
  });

  it("does not infer a size mode from a linked dimension", async () => {
    const source = workflow(), before = structuredClone(source);
    source["1"].inputs.custom_width = ["5", 1];
    await expect(prepareNativeRunningHubMedia(source, [uploaded], reader(contracts()))).rejects.toThrow("未提交任务");
    expect(source["1"].inputs).toEqual({ ...before["1"].inputs, custom_width: ["5", 1] });
  });

  it("retains linked dimensions when the author supplied an explicit supported mode", async () => {
    const source = workflow();
    Object.assign(source["1"].inputs, { custom_width: ["5", 1], force_size: "Custom Width" });
    const before = structuredClone(source);
    const result = await prepareNativeRunningHubMedia(source, [uploaded], reader(contracts()));
    expect(result["1"].inputs).toEqual({ ...before["1"].inputs, video: uploaded.inputName });
    expect(source).toEqual(before);
  });
});
