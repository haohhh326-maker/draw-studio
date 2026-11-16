import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DirectorNativeSettings } from "../src/director/DirectorNativeSettings";
import {
  DIRECTOR_NATIVE_SETTINGS,
  directorNativeChoices,
  directorNativeSettingPatch,
  directorNativeSettings,
} from "../src/director/native-settings";

describe("director native settings contract", () => {
  it("emits only the edited widget field without touching prompt or timeline data", () => {
    const values = {
      seed: 12,
      steps: 8,
      global_prompt: "PRIVATE DRAFT",
      timeline_data: "PRIVATE TIMELINE",
    };
    expect(directorNativeSettingPatch("steps", "25", values)).toEqual({
      steps: 25,
    });
    expect(directorNativeSettingPatch("cfg", "1.25", values)).toEqual({
      cfg: 1.25,
    });
    expect(values.steps).toBe(8);
    for (const field of [
      "global_prompt",
      "timeline_data",
      "control_after_generate",
      "api_key",
    ])
      expect(() =>
        directorNativeSettingPatch(field, "hidden data", values),
      ).toThrow("不是当前工作流");
  });

  it.each(["", "NaN", "Infinity", "201", "0", "4.5"])(
    "rejects invalid or unsupported step value %s without silently clamping it",
    (value) => {
      expect(() => directorNativeSettingPatch("steps", value, {})).toThrow();
    },
  );

  it("rejects unsafe integer seeds rather than silently changing their digits", () => {
    expect(directorNativeSettingPatch("seed", "9007199254740991", {})).toEqual({
      seed: Number.MAX_SAFE_INTEGER,
    });
    expect(() =>
      directorNativeSettingPatch("seed", "9007199254740993", {}),
    ).toThrow();
    expect(() =>
      directorNativeSettingPatch("seed", "18446744073709551615", {}),
    ).toThrow();
    expect(() => directorNativeSettingPatch("seed", -1, {})).toThrow();
  });

  it("uses runtime enum values and preserves the workflow's custom sampler without inventing choices", () => {
    const field = DIRECTOR_NATIVE_SETTINGS.find(
      (item) => item.key === "sampler",
    )!;
    if (field.kind !== "select") throw new Error("expected select field");
    expect(directorNativeChoices(field, "custom_runtime_sampler")).toEqual([
      "custom_runtime_sampler",
    ]);
    expect(() =>
      directorNativeSettingPatch("sampler", "guessed_sampler", {
        sampler: "res_multistep",
      }),
    ).toThrow("有效选项");
    const options = {
      samplerOptions: [
        "custom_runtime_sampler",
        "runtime_second",
        "runtime_second",
        "",
      ],
    };
    expect(
      directorNativeChoices(field, "custom_runtime_sampler", options),
    ).toEqual(["custom_runtime_sampler", "runtime_second"]);
    expect(
      directorNativeSettingPatch("sampler", "runtime_second", {}, options),
    ).toEqual({ sampler: "runtime_second" });
  });

  it("does not advertise inactive refinement features and respects externally supplied sigmas", () => {
    expect(
      directorNativeSettings().some(
        (field) => field.key === "clear_vram_before_refine",
      ),
    ).toBe(false);
    const linked = { linkedInputs: ["sigmas", "refine", "face_refine"] };
    expect(
      directorNativeSettings(linked).filter((field) => field.requiresInput),
    ).toHaveLength(2);
    expect(() => directorNativeSettingPatch("steps", 10, {}, linked)).toThrow(
      "外部 sigmas",
    );
    expect(() =>
      directorNativeSettingPatch("scheduler", "simple", {}, linked),
    ).toThrow("外部 sigmas");
    expect(
      directorNativeSettingPatch("clear_vram_before_refine", true, {}, linked),
    ).toEqual({ clear_vram_before_refine: true });
  });

  it("uses the actual two cache codecs and rejects string booleans", () => {
    expect(
      directorNativeSettingPatch("cache_frames_codec", "ffv1", {}),
    ).toEqual({ cache_frames_codec: "ffv1" });
    expect(() =>
      directorNativeSettingPatch("cache_frames_codec", "h264", {}),
    ).toThrow();
    expect(
      directorNativeSettingPatch("clear_vram_between_segments", false, {}),
    ).toEqual({ clear_vram_between_segments: false });
    expect(() =>
      directorNativeSettingPatch("clear_vram_between_segments", "false", {}),
    ).toThrow();
  });

  it("renders a closed compact panel without prompt contents or fake generation controls", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DirectorNativeSettings, {
        values: { steps: 8, global_prompt: "MUST NOT APPEAR" },
        onChange,
        disabled: true,
      }),
    );
    expect(html).toContain("采样与性能");
    expect(html).toContain('aria-label="导演台步数"');
    expect(html).toContain('value="8"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("MUST NOT APPEAR");
    expect(html).not.toContain("control_after_generate");
    expect(html).not.toContain("修脸前");
    expect(html.match(/<details[^>]*>/)?.[0]).not.toContain("open");
    expect(onChange).not.toHaveBeenCalled();
  });
});
