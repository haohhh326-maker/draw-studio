import type { Parameter } from "../types";

type SourceControl = { kind: string; valueType: string; order: number };
type SourceControlledParameter = Parameter & { sourceControl?: SourceControl };

/** Resolve a displayed option ID without collapsing differently typed values. */
export function parameterOptionKey(parameter: Pick<Parameter, "options" | "optionValues">, value: unknown): string {
  const options = parameter.options ?? Object.keys(parameter.optionValues ?? {});
  for (const key of options) {
    const candidate = parameter.optionValues && Object.hasOwn(parameter.optionValues, key) ? parameter.optionValues[key] : key;
    if (Object.is(candidate, value)) return key;
  }
  return String(value);
}

/** Enforce only the source types and numeric bounds carried by this RH field. */
export function validateRunningHubParameterValue(parameter: Parameter, value: unknown): void {
  const source = (parameter as SourceControlledParameter).sourceControl;
  if (!source) return;
  const name = parameter.label || parameter.key;
  const type = source.valueType.trim().toUpperCase();
  const integer = type === "INT" || type === "INTEGER";
  const numeric = integer || ["FLOAT", "DOUBLE", "NUMBER"].includes(type);
  if (numeric) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("请输入有限数值：" + name);
    if (integer && !Number.isInteger(value)) throw new Error("请输入整数：" + name);
    if (typeof parameter.min === "number" && Number.isFinite(parameter.min) && value < parameter.min) throw new Error("参数小于最小值 " + parameter.min + "：" + name);
    if (typeof parameter.max === "number" && Number.isFinite(parameter.max) && value > parameter.max) throw new Error("参数大于最大值 " + parameter.max + "：" + name);
    if (typeof parameter.step === "number" && Number.isFinite(parameter.step) && parameter.step > 0) {
      const origin = typeof parameter.min === "number" && Number.isFinite(parameter.min) ? parameter.min : 0;
      const quotient = (value - origin) / parameter.step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-8) throw new Error("参数不符合步长：" + name);
    }
  } else if (type === "BOOLEAN" || type === "BOOL") {
    if (typeof value !== "boolean") throw new Error("请输入开关值：" + name);
  } else if (type === "STRING") {
    if (typeof value !== "string") throw new Error("请输入文本：" + name);
  }
  if (source.kind === "select" || type === "COMBO" || parameter.type === "select") {
    const options = parameter.options ?? Object.keys(parameter.optionValues ?? {});
    const valid = options.some(key => Object.is(parameter.optionValues && Object.hasOwn(parameter.optionValues, key) ? parameter.optionValues[key] : key, value));
    if (!valid) throw new Error("参数选项无效：" + name);
  }
}
