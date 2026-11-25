import type { CanvasNode, WorkflowDefinition, ApiWorkflow } from "../types";
import { plural, type ResolvedInput } from "../semantic/resolver";
import { relativePath } from "../comfyui/files";
import { omitUnconnectedMedia } from "../workflow/media-input-policy";
import { validateRunningHubParameterValue } from "../runninghub/parameter-contract";
export function validateDefinition(w: WorkflowDefinition) {
  if (w.library?.executionIssue)
    throw new Error("工作流已加入目录，执行仍需适配：" + w.library.executionIssue);
  if (w.source?.issues.length)
    throw new Error("此工作流仍需适配：" + w.source.issues.join("；"));
  if (!w.template) throw new Error("该生成能力尚未配置，暂时无法生成。");
  const outputs = [w.output, ...(w.additionalOutputs ?? [])];
  for (const output of outputs) {
    if (!w.template[output.nodeId] || !output.field.trim() || !["image", "video", "audio", "text", "file"].includes(output.kind))
      throw new Error("输出节点或输出字段无效，请检查工作流映射。");
    if (output.prefix) {
      const { nodeId, field } = output.prefix;
      if (typeof w.template[nodeId]?.inputs[field] !== "string" || w.mapping.some((m) => m.nodeId === nodeId && m.field === field))
        throw new Error("输出前缀映射必须指向独立的字符串字段。");
    }
  }
  if (
    w.promptRequired !== false &&
    !w.mapping.some((m) => m.semantic === "prompt")
  )
    throw new Error("请绑定 prompt 提示词字段。");
  const targets = new Set<string>();
  for (const m of w.mapping) {
    if (
      m.index !== undefined &&
      (!Number.isInteger(m.index) || m.index < 0 || !plural.has(m.semantic))
    )
      throw new Error("素材索引必须是数组语义中的非负整数。");
    const target = JSON.stringify([m.nodeId, m.field]);
    if (targets.has(target))
      throw new Error("同一字段不能绑定多个语义输入：" + m.nodeId + "." + m.field);
    targets.add(target);
    const n = w.template[m.nodeId];
    if (!n || !(m.field in n.inputs))
      throw new Error("映射目标不存在：" + m.nodeId + "." + m.field);
    if (Array.isArray(n.inputs[m.field]))
      throw new Error("映射不能覆盖节点连接：" + m.nodeId + "." + m.field);
    if (
      m.serialization &&
      (m.serialization !== "json-paths" ||
        !plural.has(m.semantic) ||
        m.index !== undefined ||
        m.pathMode ||
        typeof n.inputs[m.field] !== "string")
    )
      throw new Error("JSON 路径列表必须绑定数组素材语义和字符串字段。");
    if (
      m.maxItems !== undefined &&
      (!plural.has(m.semantic) ||
        !Number.isInteger(m.maxItems) ||
        m.maxItems < 1)
    )
      throw new Error("素材容量必须是正整数。");
    if (m.pathMode && (m.pathMode !== "comfy-input" || typeof n.inputs[m.field] !== "string"))
      throw new Error("input 路径转换必须绑定字符串素材字段。");
  }
  for (const p of w.parameters)
    if (!w.mapping.some((m) => m.semantic === p.key))
      throw new Error("参数未绑定：" + p.label);
}
export function buildWorkflow(
  w: WorkflowDefinition,
  node: CanvasNode,
  inputs: ResolvedInput[],
  uploaded: Record<string, string>,
  outputPrefix?: string,
): {
  workflow: ApiWorkflow;
  params: Record<string, string | number | boolean>;
} {
  validateDefinition(w);
  const gen = node.data.generation;
  if (!gen) throw new Error("节点不能生成。");
  const params = {
    ...Object.fromEntries(w.parameters.map((p) => [p.key, p.default])),
    ...gen.params,
  };
  if (w.id.startsWith("wan22-")) {
    if (Number(params.switchStep) >= Number(params.steps))
      throw new Error("高低噪声切换步必须小于总步数。");
    if ((Number(params.frames) - 1) % 4 !== 0)
      throw new Error("Wan 视频帧数需要满足 4n+1，例如 49、81、121。");
  }
  for (const p of w.parameters) {
    const v = params[p.key];
    if (w.runninghub) validateRunningHubParameterValue(p, v);
    if (p.required && typeof v === "string" && !v.trim())
      throw new Error("请填写：" + p.label);
    if (
      p.type === "number" &&
      (typeof v !== "number" ||
        !Number.isFinite(v) ||
        (p.min !== undefined && v < p.min) ||
        (p.max !== undefined && v > p.max))
    )
      throw new Error("参数超出范围：" + p.label);
    if (
      (p.type === "boolean" && typeof v !== "boolean") ||
      (p.type === "text" && typeof v !== "string") ||
      (p.type === "select" && !["string", "number", "boolean"].includes(typeof v))
    )
      throw new Error("参数类型不正确：" + p.label);
    if (
      p.type === "select" &&
      (!p.options?.length || !p.options.some(option => (p.optionValues?.[option] ?? option) === v))
    )
      throw new Error("参数选项无效：" + p.label);
  }
  if (params.seed === -1) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    params.seed = a[0] % 2147483647;
  }
  const semantic: Record<string, unknown> = {
    ...params,
    prompt: gen.prompt,
    negativePrompt: gen.negativePrompt,
  };
  for (const input of inputs) {
    const name = uploaded[input.asset.id];
    if (!name) throw new Error("素材尚未上传：" + input.asset.name);
    if (plural.has(input.semantic))
      semantic[input.semantic] = [
        ...((semantic[input.semantic] as string[]) ?? []),
        name,
      ];
    else semantic[input.semantic] = name;
  }
  let workflow = structuredClone(w.template!);
  for (const m of w.mapping) {
    let value = semantic[m.semantic];
    if (m.index !== undefined)
      value = Array.isArray(value) ? value[m.index] : undefined;
    if (value === undefined) {
      if (w.requiredInputs.includes(m.semantic))
        throw new Error("映射缺少输入：" + m.semantic);
      continue;
    }
    if (m.pathMode === "comfy-input") {
      if (typeof value !== "string")
        throw new Error("图片加载字段需要单个文件路径。");
      value = "input/" + relativePath(value);
    }
    if (
      m.maxItems !== undefined &&
      Array.isArray(value) &&
      value.length > m.maxItems
    )
      throw new Error("参考素材数量超过工作流容量：" + m.maxItems);
    if (m.serialization === "json-paths") {
      if (!Array.isArray(value)) throw new Error("素材路径需要数组。");
      value = JSON.stringify(value.map((v) => relativePath(v)));
    }
    workflow[m.nodeId].inputs[m.field] = value;
  }
  if (w.dynamicReferences) {
    const dynamic = w.dynamicReferences;
    const target = workflow[dynamic.binding.targetNodeId];
    if (!target) throw new Error("多参考目标节点不存在。");
    let nextId = Math.max(...Object.keys(workflow).map(Number).filter(Number.isFinite)) + 1;
    for (const [kind, route] of Object.entries(dynamic.routes)) {
      const selected = inputs.filter(i => i.asset.kind === kind);
      if (selected.length > route.maxItems) throw new Error("参考素材超过容量。");
      const prototypes = Object.fromEntries(route.prototypeNodeIds.map(id => [id, workflow[id]]));
      for (const field of Object.keys(target.inputs))
        if (field.startsWith(route.targetInputPrefix) || (route.pairedAudioInputPrefix && field.startsWith(route.pairedAudioInputPrefix))) delete target.inputs[field];
      for (const id of route.prototypeNodeIds) delete workflow[id];
      selected.forEach((input, index) => {
        const ids = Object.fromEntries(route.prototypeNodeIds.map(id => [id, String(nextId++)]));
        for (const [id, prototype] of Object.entries(prototypes)) {
          if (!prototype) throw new Error("参考素材加载器不存在。");
          const clone = structuredClone(prototype);
          for (const [field, value] of Object.entries(clone.inputs))
            if (Array.isArray(value) && ids[value[0]]) clone.inputs[field] = [ids[value[0]], value[1]];
          workflow[ids[id]] = clone;
        }
        const loader = workflow[ids[route.pathBinding.nodeId]];
        const uploadedName = uploaded[input.asset.id];
        if (!uploadedName) throw new Error("参考素材未上传。");
        const prefix = ["Image Load", "VHS_LoadImagePath", "VHS_LoadVideoPath", "VHS_LoadAudio"].includes(loader.class_type) ? "input/" : "";
        loader.inputs[route.pathBinding.path.replace(/^inputs\./, "")] = prefix + relativePath(uploadedName);
        const output = route.output ?? route.videoOutput;
        if (!output) throw new Error("参考素材输出未配置。");
        target.inputs[route.targetInputPrefix + ((route.targetInputStartIndex ?? 0) + index)] = [ids[output.nodeId], output.index];
      });
    }
  }
  if (w.mediaInputMode === "schema" && w.mediaInputPolicy) {
    workflow = omitUnconnectedMedia(
      workflow,
      w.mediaInputPolicy,
      new Set(inputs.map(input => input.semantic)),
      [w.output.nodeId, ...(w.additionalOutputs ?? []).map(output => output.nodeId)],
    );
  }
  if (w.runninghub?.kind === "app") {
    // AIFISHER keeps authored examples in the immutable source. Resolve missing
    // public uploads only in this execution copy, using its declared empty value.
    const connected = new Set(inputs.map(input => input.semantic));
    for (const field of w.runninghub.mediaInputs ?? []) {
      const bindings = w.mapping.filter(mapping => mapping.nodeId === field.nodeId && mapping.field === field.field);
      if (bindings.some(binding => connected.has(binding.semantic))) continue;
      const label = w.inputSlots?.find(slot => bindings.some(binding => binding.semantic === slot.semantic))?.label ?? field.nodeId + "." + field.field;
      if (field.required) throw new Error("请连接必需素材：" + label);
      if (!Object.hasOwn(field, "emptyValue")) throw new Error("可选素材 " + label + " 未公开空值规则，请连接素材或重新读取应用后运行。");
      const target = workflow[field.nodeId];
      if (target) target.inputs[field.field] = field.emptyValue;
    }
  }
  if (outputPrefix) {
    relativePath(outputPrefix);
    const outputs = [w.output, ...(w.additionalOutputs ?? [])];
    const assigned = new Set<string>();
    for (const [index, output] of outputs.entries()) {
      const target = output.prefix ?? (!w.importReader && typeof workflow[output.nodeId]?.inputs.filename_prefix === "string" ? { nodeId: output.nodeId, field: "filename_prefix" } : undefined);
      if (!target) continue;
      const key = JSON.stringify([target.nodeId, target.field]);
      if (assigned.has(key)) continue;
      assigned.add(key);
      workflow[target.nodeId].inputs[target.field] = index === 0 ? outputPrefix : outputPrefix + "-output-" + index;
    }
  }
  return { workflow, params };
}
