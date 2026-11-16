import { describe, expect, it } from "vitest";
import { parameterOptionKey, validateRunningHubParameterValue } from "../src/runninghub/parameter-contract";
import type { Parameter } from "../src/types";

type SourceParameter = Parameter & { sourceControl: { kind: string; valueType: string; order: number } };
const parameter = (valueType: string, extra: Partial<SourceParameter> = {}): SourceParameter => ({ key: "rh_1_field", label: "平台字段", type: "number", default: 1,
  sourceControl: { kind: valueType === "COMBO" ? "select" : valueType === "BOOLEAN" ? "toggle" : valueType === "STRING" ? "text" : "number", valueType, order: 0 }, ...extra });

describe("RunningHub typed parameter option IDs", () => {
  const choices = { options: ["number-one", "string-one", "boolean-true", "string-true", "positive-zero", "negative-zero"],
    optionValues: { "number-one": 1, "string-one": "1", "boolean-true": true, "string-true": "true", "positive-zero": 0, "negative-zero": -0 } };
  it("keeps numbers, strings and booleans with identical text distinct", () => {
    expect(parameterOptionKey(choices, 1)).toBe("number-one");
    expect(parameterOptionKey(choices, "1")).toBe("string-one");
    expect(parameterOptionKey(choices, true)).toBe("boolean-true");
    expect(parameterOptionKey(choices, "true")).toBe("string-true");
    expect(parameterOptionKey(choices, 0)).toBe("positive-zero");
    expect(parameterOptionKey(choices, -0)).toBe("negative-zero");
  });
  it("respects published option order and supports legacy string keys", () => {
    expect(parameterOptionKey({ options: ["second", "first"], optionValues: { first: 1, second: 1 } }, 1)).toBe("second");
    expect(parameterOptionKey({ options: ["euler", "dpm"] }, "dpm")).toBe("dpm");
    expect(parameterOptionKey({ optionValues: { opaque: 7 } }, 7)).toBe("opaque");
    expect(parameterOptionKey({}, 15)).toBe("15");
    expect(parameterOptionKey(choices, "unlisted-current-value")).toBe("unlisted-current-value");
  });
});

describe("RunningHub source parameter value validation", () => {
  it("leaves legacy parameters without source metadata unchanged", () => {
    const legacy: Parameter = { key: "legacy", label: "旧字段", type: "number", default: 1, min: 0, max: 2 };
    for (const value of ["1", 1.25, -10, Number.NaN, Infinity, null, {}, false]) expect(() => validateRunningHubParameterValue(legacy, value)).not.toThrow();
  });
  it("requires finite actual integers for INT and never coerces or rounds input", () => {
    const int = parameter("INT");
    for (const value of [0, -7, 12]) expect(() => validateRunningHubParameterValue(int, value)).not.toThrow();
    for (const value of ["12", null, true, Number.NaN, Infinity]) expect(() => validateRunningHubParameterValue(int, value)).toThrow("有限数值");
    expect(() => validateRunningHubParameterValue(int, 1.25)).toThrow("整数");
    expect(() => validateRunningHubParameterValue(int, -0.25)).toThrow("整数");
  });
  it("allows fractional FLOAT values and negative values when no lower bound was declared", () => {
    const float = parameter("FLOAT", { default: 0.7 });
    for (const value of [0.7, -2.125, 1.25]) expect(() => validateRunningHubParameterValue(float, value)).not.toThrow();
    for (const value of ["0.7", Number.NaN, Infinity, -Infinity]) expect(() => validateRunningHubParameterValue(float, value)).toThrow("有限数值");
    expect(() => validateRunningHubParameterValue(parameter("FLOAT", { step: 0.1 }), 0.7)).not.toThrow();
  });
  it("enforces only explicitly declared finite minimum and maximum bounds", () => {
    const bounded = parameter("FLOAT", { min: 0, max: 2, step: 0.1 });
    for (const value of [0, 0.7, 2]) expect(() => validateRunningHubParameterValue(bounded, value)).not.toThrow();
    expect(() => validateRunningHubParameterValue(bounded, -0.1)).toThrow("最小值 0");
    expect(() => validateRunningHubParameterValue(bounded, 2.1)).toThrow("最大值 2");
    expect(() => validateRunningHubParameterValue(parameter("NUMBER", { min: Number.NaN, max: Infinity }), -1e100)).not.toThrow();
  });
  it("validates an explicitly declared numeric step using the upstream floating point tolerance", () => {
    const float = parameter("FLOAT", { step: 0.1 });
    for (const value of [0, 0.1, 0.3, 0.1 + 0.2, -0.7, 0.3000000001]) expect(() => validateRunningHubParameterValue(float, value)).not.toThrow();
    for (const value of [0.15, 0.31, -0.65, 0.30000001]) expect(() => validateRunningHubParameterValue(float, value)).toThrow("步长");
    // Omitted or unusable steps do not create an implicit integer grid.
    for (const step of [undefined, 0, -1, Number.NaN, Infinity])
      expect(() => validateRunningHubParameterValue(parameter("FLOAT", { step }), 0.715)).not.toThrow();
  });
  it("uses a finite declared minimum as the step origin instead of assuming zero", () => {
    const offset = parameter("FLOAT", { min: 0.05, max: 1, step: 0.1 });
    for (const value of [0.05, 0.15, 0.25, 0.95]) expect(() => validateRunningHubParameterValue(offset, value)).not.toThrow();
    for (const value of [0.1, 0.2, 0.3]) expect(() => validateRunningHubParameterValue(offset, value)).toThrow("步长");
    const integer = parameter("INT", { min: 1, step: 2 });
    expect(() => validateRunningHubParameterValue(integer, 3)).not.toThrow();
    expect(() => validateRunningHubParameterValue(integer, 2)).toThrow("步长");
    const legacy: Parameter = { key: "legacy", label: "Legacy", type: "number", default: 0.1, step: 0.1 };
    expect(() => validateRunningHubParameterValue(legacy, 0.15)).not.toThrow();
  });
  it("requires exact source boolean and string types", () => {
    const bool = parameter("BOOLEAN", { type: "boolean", default: true });
    for (const value of [true, false]) expect(() => validateRunningHubParameterValue(bool, value)).not.toThrow();
    for (const value of ["true", "false", 0, 1, null]) expect(() => validateRunningHubParameterValue(bool, value)).toThrow("开关值");
    const text = parameter("STRING", { type: "text", default: "author" });
    for (const value of ["", "12", "false"]) expect(() => validateRunningHubParameterValue(text, value)).not.toThrow();
    for (const value of [12, false, null, {}]) expect(() => validateRunningHubParameterValue(text, value)).toThrow("文本");
  });
  it("checks select membership by typed value, rather than displayed IDs or coercion", () => {
    const combo = parameter("COMBO", { type: "select", default: 1, options: ["number-one", "bool-false"], optionValues: { "number-one": 1, "bool-false": false } });
    expect(() => validateRunningHubParameterValue(combo, 1)).not.toThrow();
    expect(() => validateRunningHubParameterValue(combo, false)).not.toThrow();
    for (const value of ["1", "false", "number-one", "bool-false", 2]) expect(() => validateRunningHubParameterValue(combo, value)).toThrow("参数选项无效");
    const strings = parameter("COMBO", { type: "select", default: "euler", options: ["euler", "dpm"] });
    expect(() => validateRunningHubParameterValue(strings, "euler")).not.toThrow();
  });
});
