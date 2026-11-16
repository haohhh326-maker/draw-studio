import type { ApiWorkflow } from "../types";
import { validateImportGraph } from "../workflow/import-analyzer";

type NodeInfo = {input?: {required?: Record<string, unknown[]>; optional?: Record<string, unknown[]>}};
const basename = (s: string) => s.replaceAll("\\", "/").split("/").at(-1);

/** Check the actual output branch against the connected server before uploading. */
export function prepareForServer(graph: ApiWorkflow, outputId: string | string[], info: Record<string, unknown>): ApiWorkflow {
  const keep = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("工作流存在循环连接：" + id);
    if (keep.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error("工作流连接不存在：" + id);
    visiting.add(id);
    for (const value of Object.values(node.inputs))
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") visit(value[0]);
    visiting.delete(id); keep.add(id);
  }
  const roots = Array.isArray(outputId) ? outputId : [outputId];
  if (!roots.length) throw new Error("请选择工作流输出节点。");
  for (const id of roots) visit(id);
  const output = structuredClone(Object.fromEntries([...keep].map(id => [id, graph[id]])));
  const missingNodes = new Set<string>(), missingModels = new Set<string>();
  for (const node of Object.values(output)) {
    const schema = info[node.class_type] as NodeInfo | undefined;
    if (!schema) { missingNodes.add(node.class_type); continue; }
    const fields = {...schema.input?.required, ...schema.input?.optional};
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value)) continue;
      const spec = fields[field];
      const options = Array.isArray(spec?.[0]) ? spec[0] : (spec?.[1] as {options?:unknown[]} | undefined)?.options;
      if (!Array.isArray(options) || options.includes(value)) continue;
      const matches = options.filter(v => typeof v === "string" && basename(v) === basename(value));
      if (matches.length === 1) node.inputs[field] = matches[0];
      else missingModels.add(value);
    }
  }
  const errors = [missingNodes.size ? "当前服务器未注册节点：" + [...missingNodes].join("、") : "", missingModels.size ? "当前服务器未提供这些模型选项：" + [...missingModels].join("、") : ""].filter(Boolean);
  if (errors.length) throw new Error(errors.join("；") + "。请核对所连接镜像的节点和模型目录。");
  const structure = validateImportGraph(output, info);
  if (structure.errors.length) throw new Error(structure.errors.join("；"));
  return output;
}
