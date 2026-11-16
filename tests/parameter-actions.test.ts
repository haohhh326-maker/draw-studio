import { describe, expect, it } from "vitest";
import type { Parameter, WorkflowDefinition } from "../src/types";
import { catalog } from "../src/workflow/catalog";
import {
  incrementParameter,
  parameterAction,
  parameterActionAvailable,
  parameterDisplay,
  randomSeed,
} from "../src/generation/parameter-actions";

const numeric = (patch: Partial<Parameter> = {}): Parameter => ({
  key: "seed",
  label: "种子",
  type: "number",
  default: 1,
  min: 0,
  max: 900719925,
  step: 1,
  ...patch,
});
const h3 = catalog.find((w) => w.original?.id === "h3.t2v.cloud")!;

describe("parameter actions", () => {
  it("adds seed randomization to numeric seed fields across all families, without treating text, models or strengths as seeds", () => {
    for (const key of [
      "seed",
      "seed19",
      "noiseSeed131",
      "noise_seed",
      "noise_seed29",
    ])
      expect(parameterAction(numeric({ key, label: "随机值" }))?.kind).toBe(
        "seed",
      );
    expect(
      parameterAction(numeric({ key: "value13", label: "种子" }))?.kind,
    ).toBe("seed");
    expect(parameterAction(numeric({ type: "text" }))).toBeUndefined();
    expect(
      parameterAction(numeric({ key: "seedStrength", label: "强度" })),
    ).toBeUndefined();
    expect(
      parameterAction(numeric({ key: "unet", label: "模型", model: true })),
    ).toBeUndefined();
  });

  it("uses the original identity of every H3 variant to identify the actual megapixel and duration controls", () => {
    const variants = catalog.filter((w) => /^h3\./.test(w.original?.id ?? ""));
    expect(variants.length).toBeGreaterThan(10);
    for (const workflow of variants) {
      const megapixels = workflow.parameters.find(
        (p) => p.label === "百万像素",
      )!;
      expect(parameterAction(megapixels, workflow)).toMatchObject({
        kind: "increment",
        amount: 0.1,
      });
      const duration = workflow.parameters.find((p) => p.label === "时长");
      if (duration)
        expect(parameterAction(duration, workflow)).toMatchObject({
          kind: "increment",
          amount: 1,
        });
      const seed = workflow.parameters.find((p) => p.label === "种子")!;
      expect(parameterAction(seed, workflow)?.kind).toBe("seed");
    }
  });

  it("limits numeric increments to H3 while supporting its localized family labels", () => {
    const megapixels = numeric({
      key: "megapixels115",
      label: "百万像素",
      default: 0.6,
    });
    const seconds = numeric({ key: "value135", label: "时长", default: 5 });
    const other = { ...h3, original: undefined, family: "MiniMax Music" };
    expect(parameterAction(megapixels, other)).toBeUndefined();
    expect(parameterAction(seconds, other)).toBeUndefined();
    const familyOnly: WorkflowDefinition = {
      ...other,
      family: "MiniMax H3 极速",
    };
    expect(parameterAction(megapixels, familyOnly)?.kind).toBe("increment");
    expect(parameterAction(seconds, familyOnly)?.kind).toBe("increment");
    expect(
      parameterAction(
        numeric({ key: "steps126", label: "采样步数" }),
        familyOnly,
      ),
    ).toBeUndefined();
  });

  it("returns a different seed within inclusive limits even when the random sample would have selected the current value", () => {
    const parameter = numeric({ min: 2, max: 5 });
    const results = [0n, 1n, 2n].map((sample) =>
      randomSeed(parameter, 3, () => sample),
    );
    expect(results).toEqual([2, 4, 5]);
    expect(
      results.every(
        (value) =>
          Number.isSafeInteger(value) &&
          value !== 3 &&
          value >= 2 &&
          value <= 5,
      ),
    ).toBe(true);
  });

  it("preserves the entire safe integer domain without overflowing its upper endpoint", () => {
    const parameter = numeric({ min: -1, max: Number.MAX_SAFE_INTEGER });
    expect(randomSeed(parameter, -1, () => 0n)).toBe(0);
    expect(randomSeed(parameter, -1, () => (1n << 53n) - 1n)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(randomSeed(parameter, Number.MAX_SAFE_INTEGER, () => 0n)).toBe(0);
    expect(randomSeed(numeric({ min: 1.2, max: 4.8 }), -1, () => 2n)).toBe(4);
  });

  it("rejects surplus random samples so modulo reduction does not skew the bounded integer result", () => {
    const samples = [(1n << 53n) - 1n, 3n];
    expect(
      randomSeed(numeric({ min: 2, max: 5 }), 3, () => samples.shift()!),
    ).toBe(2);
    expect(samples).toHaveLength(0);
  });

  it("disables an exhausted or invalid seed range and still allows correcting a value outside a one-value range", () => {
    const action = parameterAction(numeric())!;
    expect(
      parameterActionAvailable(numeric({ min: 7, max: 7 }), 7, action),
    ).toBe(false);
    expect(
      parameterActionAvailable(numeric({ min: 7, max: 7 }), 4, action),
    ).toBe(true);
    expect(randomSeed(numeric({ min: 7, max: 7 }), 4, () => 0n)).toBe(7);
    expect(
      parameterActionAvailable(numeric({ min: 9, max: 2 }), 4, action),
    ).toBe(false);
    expect(() => randomSeed(numeric({ min: 9, max: 2 }), 4)).toThrow(
      /安全整数范围/,
    );
  });

  it("adds exactly 0.1 per megapixel click, clamps boundaries and disables further increases at the maximum", () => {
    const parameter = h3.parameters.find((p) => p.label === "百万像素")!;
    const action = parameterAction(parameter, h3)!;
    let value = 0.6;
    for (let index = 0; index < 4; index++)
      value = incrementParameter(parameter, value, 0.1);
    expect(value).toBe(1);
    expect(incrementParameter(parameter, 1.95, 0.1)).toBe(2);
    expect(incrementParameter(parameter, -1, 0.1)).toBe(0.2);
    expect(parameterActionAvailable(parameter, 2, action)).toBe(false);
    expect(parameterActionAvailable(parameter, 1.9, action)).toBe(true);
  });

  it("adds one second to duration without changing the workflow definition or exceeding its source limits", () => {
    const parameter = h3.parameters.find((p) => p.label === "时长")!;
    const before = structuredClone(parameter);
    expect(incrementParameter(parameter, 5, 1)).toBe(6);
    expect(incrementParameter(parameter, parameter.max!, 1)).toBe(
      parameter.max,
    );
    expect(incrementParameter(parameter, NaN, 1)).toBe(
      Number(parameter.default) + 1,
    );
    expect(parameter).toEqual(before);
  });

  it("displays fractional parameters without floating-point tails while preserving exact integer seeds", () => {
    expect(parameterDisplay(0.1 + 0.2)).toBe("0.3");
    expect(parameterDisplay(0.6000000000000001)).toBe("0.6");
    expect(parameterDisplay(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(parameterDisplay("9:16")).toBe("9:16");
  });
});
