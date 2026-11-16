import { describe, expect, it } from "vitest";
import type { ApiWorkflow } from "../src/types";
// @ts-expect-error The original mode mapping is distributed as plain JavaScript.
import { getDirectorMode } from "../vendor/minimax-director/web/js/minimax_gen_timeline.js";
import {
  directorExecutionModes,
  directorModelLoader,
  prepareDirectorModeModel,
} from "../src/director/mode-model";

const trustedId = "2113192715495235585";
function graph(filename = "minimax_h3_ref2va_bf16.safetensors"): ApiWorkflow {
  return {
    director: {
      class_type: "MiniMaxH3Director",
      inputs: { model: ["attention", 0] },
    },
    attention: {
      class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch",
      inputs: { model: ["lora", 0] },
    },
    lora: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["active", 0],
        lora_name: "verified-original-turbo.safetensors",
        strength_model: 0.75,
      },
    },
    active: {
      class_type: "UNETLoader",
      inputs: { unet_name: filename, weight_dtype: "default" },
    },
    unused: {
      class_type: "UNETLoader",
      inputs: { unet_name: "unrelated_ref2va.safetensors" },
    },
  };
}

describe("director model selection", () => {
  it.each(["t2v", "i2v", "fl2v"])(
    "selects the confirmed fl2va model for %s while preserving the active chain and unrelated loaders",
    (mode) => {
      const source = graph(),
        original = structuredClone(source);
      const result = prepareDirectorModeModel(
        source,
        "director",
        trustedId,
        `${mode} — label`,
        {},
      );
      expect(result.family).toBe("fl2va");
      expect(result.loaderNodeId).toBe("active");
      expect(result.template.active.inputs.unet_name).toBe(
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      );
      expect(result.template).toEqual({
        ...source,
        active: {
          ...source.active,
          inputs: {
            ...source.active.inputs,
            unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          },
        },
      });
      expect(source).toEqual(original);
    },
  );

  it.each(["r2v", "v2v", "rv2v"])(
    "selects the confirmed ref2va model for %s",
    (mode) => {
      const result = prepareDirectorModeModel(
        graph("minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
        "director",
        trustedId,
        mode,
        {},
      );
      expect(result.family).toBe("ref2va");
      expect(result.template.active.inputs.unet_name).toBe(
        "minimax_h3_ref2va_bf16.safetensors",
      );
    },
  );

  it("supports the earlier confirmed default ID without inventing a catalog for unrelated workflows", () => {
    expect(
      prepareDirectorModeModel(
        graph(),
        "director",
        "2113664133047603202",
        "t2v",
        {},
      ).family,
    ).toBe("fl2va");
    expect(() =>
      prepareDirectorModeModel(graph(), "director", "arbitrary-id", "t2v", {}),
    ).toThrow("尚未确认对应底模");
    expect(() =>
      prepareDirectorModeModel(
        graph("fl2va.safetensors"),
        "director",
        "arbitrary-id",
        "r2v",
        {},
      ),
    ).toThrow("尚未确认对应底模");
  });

  it("does not reject a valid custom fl2va graph because an unconnected ref2va loader also exists", () => {
    const source = graph("custom_fl2va.safetensors");
    expect(
      prepareDirectorModeModel(source, "director", "custom", "i2v", {})
        .template,
    ).toEqual(source);
  });

  it.each([
    "custom_ref2va.safetensors",
    "custom/minimax_h3_ref2va_bf16.safetensors",
    "other\\minimax_h3_ref2va_bf16.safetensors",
  ])(
    "does not replace a custom source model under a known workflow ID: %s",
    (filename) => {
      const source = graph(filename),
        original = structuredClone(source);
      expect(() =>
        prepareDirectorModeModel(source, "director", trustedId, "i2v", {}),
      ).toThrow("不能自动替换自定义底模");
      expect(source).toEqual(original);
      expect(
        prepareDirectorModeModel(source, "director", trustedId, "r2v", {})
          .template,
      ).toEqual(original);
    },
  );

  it.each([
    "missing",
    "cycle",
    "ambiguous",
    "wrong-output",
    "intermediate-output",
  ])("rejects an unprovable model chain: %s", (scenario) => {
    const source = graph();
    if (scenario === "missing") delete source.active;
    if (scenario === "cycle")
      source.active = {
        class_type: "ModelPatch",
        inputs: { model: ["lora", 0] },
      };
    if (scenario === "ambiguous") source.lora.inputs.model2 = ["unused", 0];
    if (scenario === "wrong-output") source.lora.inputs.model = ["active", 1];
    if (scenario === "intermediate-output")
      source.director.inputs.model = ["attention", 1];
    expect(() => directorModelLoader(source, "director")).toThrow(
      "无法确认导演台实际连接",
    );
  });

  it("does not overwrite an unidentified model even for a cataloged workflow", () => {
    expect(() =>
      prepareDirectorModeModel(
        graph("unknown.safetensors"),
        "director",
        trustedId,
        "i2v",
        {},
      ),
    ).toThrow("无法确认当前 UNET");
  });
});

describe("director mixed mode follows upstream semantics", () => {
  it("defaults missing and unsupported mixed segment modes to t2v and reads task_type aliases", () => {
    expect(
      directorExecutionModes("mixed", {
        segments: [
          {},
          { taskType: "v2v" },
          { task_type: "i2v – label" },
          { taskType: "r2v — label" },
        ],
      }),
    ).toEqual(["t2v", "t2v", "i2v", "r2v"]);
    expect(directorExecutionModes("mixed", { segments: [] })).toEqual(["t2v"]);
  });

  it("honors the same global task override that the backend reads", () => {
    expect(
      directorExecutionModes("r2v", { global: { taskType: "i2v — label" } }),
    ).toEqual(["i2v"]);
  });

  it("keeps a same-family mixed timeline intact", () => {
    const timeline = {
      segments: [
        { taskType: "t2v", prompt: "first draft" },
        { taskType: "i2v", refs: [{ imageFile: "local.png" }] },
        { taskType: "fl2v" },
      ],
      runSelectEnabled: true,
      runSelection: [0],
    };
    const saved = structuredClone(timeline);
    expect(
      prepareDirectorModeModel(
        graph(),
        "director",
        trustedId,
        "mixed",
        timeline,
      ).family,
    ).toBe("fl2va");
    expect(timeline).toEqual(saved);
    expect(
      prepareDirectorModeModel(graph(), "director", trustedId, "mixed", {
        segments: [{ taskType: "r2v" }, { taskType: "r2v" }],
      }).family,
    ).toBe("ref2va");
  });

  it("rejects a cross-family mixed run instead of silently reusing a wrong model or removing groups", () => {
    const source = graph(),
      timeline = {
        segments: [{ taskType: "t2v" }, { taskType: "r2v" }],
        runSelectEnabled: true,
        runSelection: [0, 1],
      };
    expect(() =>
      prepareDirectorModeModel(
        source,
        "director",
        trustedId,
        "mixed",
        timeline,
      ),
    ).toThrow("一次运行共用一个底模");
    expect(source.active.inputs.unet_name).toBe(
      "minimax_h3_ref2va_bf16.safetensors",
    );
    expect(timeline.segments).toHaveLength(2);
  });

  it.each([
    [0, "fl2va"],
    [1, "ref2va"],
  ] as const)(
    "uses only selected group %s to choose %s while retaining other groups for cached export",
    (selected, family) => {
      const timeline = {
        segments: [
          { taskType: "t2v", prompt: "cached group" },
          { taskType: "r2v", prompt: "another group" },
        ],
        runSelectEnabled: true,
        runSelection: [selected, String(selected), -1, 9, false, null],
      };
      const original = structuredClone(timeline);
      const result = prepareDirectorModeModel(
        graph(),
        "director",
        trustedId,
        "mixed",
        timeline,
      );
      expect(result.family).toBe(family);
      expect(result.modes).toEqual([selected === 0 ? "t2v" : "r2v"]);
      expect(timeline).toEqual(original);
    },
  );

  it("honors original snake-case selection fields and rejects empty effective selections", () => {
    expect(
      directorExecutionModes("mixed", {
        segments: [{ taskType: "r2v" }, { taskType: "fl2v" }],
        run_select_enabled: true,
        run_selection: [1],
      }),
    ).toEqual(["fl2v"]);
    expect(() =>
      directorExecutionModes("mixed", {
        segments: [{ taskType: "r2v" }],
        runSelectEnabled: true,
        runSelection: [-1, 3, "bad"],
      }),
    ).toThrow("请选择");
  });
});

describe("director timeline mode consistency", () => {
  it.each(["t2v", "i2v", "r2v", "v2v", "rv2v", "mixed"])(
    "rejects an old imported fl2v timeline with effective task %s without changing its draft",
    (task) => {
      const timeline = {
        timelineMode: "fl2v",
        global: { taskType: `${task} — old label` },
        segments: [{ prompt: "session-only draft" }],
        keyframes: [{ imageFile: "first.png" }],
      };
      const original = structuredClone(timeline);
      expect(() => directorExecutionModes("fl2v", timeline)).toThrow(
        "时间线还保留首尾帧模式",
      );
      expect(timeline).toEqual(original);
    },
  );

  it.each(["t2v", "i2v", "fl2v", "r2v", "v2v", "rv2v", "mixed"])(
    "accepts the original UI's post-switch %s snapshot, including a cached fl2v workspace",
    (task) => {
      // applyTaskLayout sets the live root mode with this pinned upstream function;
      // buildTimelinePayload keeps the corresponding live task in global.taskType.
      const timeline = {
        timelineMode: getDirectorMode(task),
        global: { taskType: `${task} — label` },
        segments: [{ taskType: "t2v" }],
        fl2vWorkspace: {
          timelineMode: "fl2v",
          global: { taskType: "fl2v" },
          keyframes: [],
        },
      };
      const original = structuredClone(timeline);
      expect(directorExecutionModes("fl2v", timeline)).toEqual([
        task === "mixed" ? "t2v" : task,
      ]);
      expect(timeline).toEqual(original);
    },
  );

  it("matches backend case handling, keeps valid legacy shapes, and uses the effective global task", () => {
    expect(() =>
      directorExecutionModes("r2v", { timelineMode: "FL2V" }),
    ).toThrow("时间线还保留首尾帧模式");
    expect(
      directorExecutionModes("r2v", {
        global: { taskType: "fl2v" },
        timelineMode: "fl2v",
      }),
    ).toEqual(["fl2v"]);
    expect(directorExecutionModes("fl2v", {})).toEqual(["fl2v"]);
    expect(
      directorExecutionModes("i2v", { timelineMode: "gen_image" }),
    ).toEqual(["i2v"]);
    expect(
      directorExecutionModes("t2v", { timelineMode: "image_batch" }),
    ).toEqual(["t2v"]);
  });
});
