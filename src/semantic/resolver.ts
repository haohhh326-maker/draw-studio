import { roleLabels, type Asset, type Canvas, type WorkflowDefinition } from "../types";
export type ResolvedInput = {
  semantic: string;
  asset: Asset;
  edgeId: string;
  order?: number;
};
export const plural = new Set([
  "images",
  "referenceImages",
  "referenceVideos",
  "videos",
  "audios",
  "referenceAudios",
  "references",
]);
type InputSlot = NonNullable<WorkflowDefinition["inputSlots"]>[number];
const kindNames = { image: "图片", video: "视频", audio: "音频" };
const museReferenceRoles = {
  image: { semantic: "referenceImages", role: "referenceImage", label: "参考图片", aliases: ["image", "images", "referenceImage", "referenceImages", "firstFrame", "lastFrame", "mask", "characterReference", "styleReference", "sceneReference"] },
  video: { semantic: "referenceVideos", role: "referenceVideo", label: "参考视频", aliases: ["video", "videos", "referenceVideo", "referenceVideos"] },
  audio: { semantic: "referenceAudios", role: "referenceAudio", label: "参考音频", aliases: ["audio", "audios", "referenceAudio", "referenceAudios"] },
};
function museRoleKind(role: string) {
  // Existing canvases may have explicitly selected one of the original image slots.
  if (/^slot:muse-image-[1-4]$/.test(role)) return "image";
  return (Object.keys(museReferenceRoles) as (keyof typeof museReferenceRoles)[])
    .find(kind => museReferenceRoles[kind].aliases.includes(role));
}
function slotLabel(slot: InputSlot, index: number) {
  return slot.label.trim() || kindNames[slot.kind] + "输入 " + (index + 1);
}
export function workflowInputRoleLabel(workflow: WorkflowDefinition | undefined, role: string, kind?: Asset["kind"]): string {
  const museKind = workflow?.muse && museRoleKind(role);
  if (museKind) return museReferenceRoles[museKind].label;
  const slots = workflow?.inputSlots ?? [];
  const exact = slots.findIndex(slot => slot.semantic === role);
  if (exact >= 0) return slotLabel(slots[exact], exact) + " · " + (slots[exact].required ? "必需" : "可选");
  if (role.startsWith("slot:")) return "输入已移除，请重新选择";
  if ((role === "firstFrame" || role === "lastFrame") && slots.length && kind === "image") {
    const images = slots.filter(slot => slot.kind === "image");
    const slot = role === "firstFrame" ? images[0] : images.at(-1);
    if (slot) return (role === "firstFrame" ? "首帧" : "尾帧") + " · " + slotLabel(slot, slots.indexOf(slot));
  }
  return roleLabels[role as keyof typeof roleLabels] ?? "请重新选择输入";
}
/** Imported input choices come from the selected workflow, not a fixed role list. */
export function workflowInputRoleOptions(workflow?: WorkflowDefinition, kind?: Asset["kind"], current = "auto") {
  if (workflow?.muse) {
    const options = [{ value: "auto", label: "自动分配" }, ...Object.entries(museReferenceRoles)
      .filter(([referenceKind]) => !kind || referenceKind === kind)
      .map(([, reference]) => ({ value: reference.role, label: reference.label }))];
    if (!options.some(option => option.value === current)) options.push({ value: current, label: workflowInputRoleLabel(workflow, current, kind) });
    return options;
  }
  if (!workflow?.inputSlots || workflow.dynamicReferences) {
    const options = Object.entries(roleLabels).filter(([value]) => value !== "prompt").map(([value, label]) => ({ value, label }));
    if (current.startsWith("slot:") && !options.some(option => option.value === current)) options.push({ value: current, label: "输入已移除，请重新选择" });
    return options;
  }
  const options = [{ value: "auto", label: "自动分配" }, ...workflow.inputSlots.flatMap((slot, index) =>
    kind && slot.kind !== kind ? [] : [{ value: slot.semantic, label: slotLabel(slot, index) + " · " + (slot.required ? "必需" : "可选") }])];
  if (!options.some(option => option.value === current)) options.push({ value: current, label: workflowInputRoleLabel(workflow, current, kind) });
  return options;
}
function missingSlotsMessage(slots: InputSlot[], used: Set<string>, result: ResolvedInput[]) {
  const missing = slots.filter(slot => slot.required && !used.has(slot.semantic));
  if (!missing.length) return undefined;
  const connected = (["image", "video", "audio"] as const).filter(kind => slots.some(slot => slot.kind === kind))
    .map(kind => result.filter(input => input.asset.kind === kind).length + (kind === "image" ? " 张图片" : kind === "video" ? " 个视频" : " 个音频")).join("、");
  const labels = missing.slice(0, 3).map(slot => {
    const label = slotLabel(slot, slots.indexOf(slot));
    return label.length > 32 ? label.slice(0, 31) + "…" : label;
  }).join("、") + (missing.length > 3 ? "等 " + missing.length + " 项" : "");
  return "已连接 " + connected + "；仍缺 " + missing.length + " 个必需输入：" + labels + "。请连接素材，或为已有连线指定对应输入。";
}
export function resolveInputs(
  canvas: Canvas,
  nodeId: string,
  w: WorkflowDefinition,
  assets: Record<string, Asset>,
): ResolvedInput[] {
  const edges = canvas.edges
    .filter(
      (e) =>
        e.target === nodeId &&
        !canvas.nodes.some((n) => n.id === e.source && (n.data.kind === "text" || (n.data.kind === "tool" && n.data.text !== undefined))),
    )
    .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0));
  const result: ResolvedInput[] = [];
  if (w.muse) {
    // Muse uploads connected media directly; it has no numbered graph input slots.
    for (const edge of edges) {
      const source = canvas.nodes.find(node => node.id === edge.source);
      const asset = source?.data.assetId ? assets[source.data.assetId] : undefined;
      if (!asset) throw new Error("连接的素材「" + (source?.data.title ?? "未知") + "」尚未准备好。");
      if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio")
        throw new Error("Muse 参考素材仅支持图片、视频和音频。");
      const role = edge.data?.role ?? "auto", roleKind = museRoleKind(role);
      if (role !== "auto" && !roleKind) throw new Error("连线指定的输入不适用于 Muse，请重新选择素材输入。");
      if (roleKind && roleKind !== asset.kind) throw new Error("「" + museReferenceRoles[roleKind].label + "」需要" + kindNames[roleKind] + "素材。");
      result.push({ semantic: museReferenceRoles[asset.kind].semantic, asset, edgeId: edge.id, order: edge.data?.order ?? 0 });
    }
    return result;
  }
  if (w.inputSlots || w.dynamicReferences) {
    const slots = w.inputSlots ?? [];
    const used = new Set<string>();
    const explicitSlots = new Map<string, string>();
    for (const edge of edges) {
      const source = canvas.nodes.find(n => n.id === edge.source);
      const asset = source?.data.assetId ? assets[source.data.assetId] : undefined;
      const role = edge.data?.role ?? "auto";
      const exact = slots.find(slot => slot.semantic === role);
      if (role.startsWith("slot:") && !exact) throw new Error("连线指定的输入已不存在于当前工作流，请重新选择素材输入。");
      if (exact && asset && exact.kind !== asset.kind) throw new Error("输入「" + slotLabel(exact, slots.indexOf(exact)) + "」需要" + kindNames[exact.kind] + "素材；当前连接的是" + (kindNames[asset.kind as keyof typeof kindNames] ?? "文件") + "。");
      if ((role === "firstFrame" || role === "lastFrame") && asset && asset.kind !== "image") throw new Error("首尾帧角色需要图片素材。");
      const candidates = slots.filter(s => s.kind === asset?.kind);
      const slot = exact ?? (role === "firstFrame" ? candidates[0] : role === "lastFrame" ? candidates.at(-1) : undefined);
      if (!w.dynamicReferences && (role === "firstFrame" || role === "lastFrame") && asset && !slot) throw new Error("当前工作流没有首尾帧对应的图片输入，请重新选择角色。");
      if (slot) explicitSlots.set(edge.id, slot.semantic);
    }
    const reservedSlots = new Set(explicitSlots.values());
    for (const edge of edges) {
      const source = canvas.nodes.find(n => n.id === edge.source);
      const asset = source?.data.assetId ? assets[source.data.assetId] : undefined;
      if (!asset) throw new Error("连接的素材「" + (source?.data.title ?? "未知") + "」尚未准备好。");
      if (w.dynamicReferences) {
        const route = w.dynamicReferences.routes[asset.kind];
        if (!route) throw new Error("此工作流不接受此类素材：" + asset.kind);
        if (result.filter(i => i.asset.kind === asset.kind).length >= route.maxItems) throw new Error("此类参考素材最多 " + route.maxItems + " 个。");
        result.push({semantic: "dynamic:" + asset.kind, asset, edgeId:edge.id, order:edge.data?.order ?? 0});
      } else {
        const candidates = slots.filter(s => s.kind === asset.kind);
        const designated = candidates.find(s => s.semantic === explicitSlots.get(edge.id));
        const available = candidates.filter(s => !used.has(s.semantic) && !reservedSlots.has(s.semantic));
        const slot = designated ?? available.find(s => s.required) ?? available[0];
        if (designated && used.has(designated.semantic)) throw new Error("输入「" + slotLabel(designated, slots.indexOf(designated)) + "」的角色重复，请为连线指定不同输入。");
        if (!slot) throw new Error(candidates.length ? "连接素材超过输入容量：" + asset.name : "当前工作流没有" + (kindNames[asset.kind as keyof typeof kindNames] ?? "此类") + "素材输入。请重新选择工作流或移除连接。");
        used.add(slot.semantic);
        result.push({semantic:slot.semantic, asset, edgeId:edge.id, order:edge.data?.order ?? 0});
      }
    }
    const missing = missingSlotsMessage(slots, used, result);
    if (missing) throw new Error(missing);
    if (w.dynamicReferences) {
      if (result.length < w.dynamicReferences.constraints.minTotal) throw new Error("请连接参考素材。");
      for (const [kind, min] of Object.entries(w.dynamicReferences.constraints.minimumByType ?? {}))
        if (result.filter(i => i.asset.kind === kind).length < min) throw new Error("至少连接 " + min + " 个" + ({image:"图像",video:"视频",audio:"音频"}[kind] ?? kind) + "参考素材。");
    }
    return result;
  }
  // Reserve explicit slots before assigning AUTO connections.
  const reserved = new Set(
    edges.map((e) => e.data?.role).filter((r) => r && r !== "auto"),
  );
  for (const e of edges) {
    const source = canvas.nodes.find((n) => n.id === e.source);
    const asset = source?.data.assetId
      ? assets[source.data.assetId]
      : undefined;
    if (!asset)
      throw new Error(
        "连接的素材「" + (source?.data.title ?? "未知") + "」尚未准备好。",
      );
    let role: string = e.data?.role ?? "auto";
    if (role === "auto") {
      const configured = new Set([
        ...w.requiredInputs,
        ...w.optionalInputs,
        ...w.mapping.map((m) => m.semantic),
      ]);
      if (asset.kind === "video")
        role =
          ["referenceVideos", "videos", "referenceVideo", "video"].find((key) =>
            configured.has(key),
          ) ?? "referenceVideo";
      else if (asset.kind === "audio")
        role =
          ["audios", "referenceAudios", "audio", "referenceAudio"].find((key) =>
            configured.has(key),
          ) ?? "audio";
      else if (w.mode === "first-last-frame")
        role =
          !reserved.has("firstFrame") &&
          !result.some((r) => r.semantic === "firstFrame")
            ? "firstFrame"
            : "lastFrame";
      else if (configured.has("images")) role = "images";
      else if (
        w.mode === "multi-reference" ||
        configured.has("referenceImages")
      )
        role = "referenceImages";
      else role = "image";
    }
    if (
      [
        "firstFrame",
        "lastFrame",
        "image",
        "images",
        "referenceImage",
        "referenceImages",
        "mask",
        "characterReference",
        "styleReference",
        "sceneReference",
      ].includes(role) &&
      asset.kind !== "image"
    )
      throw new Error("「" + role + "」需要图片素材。");
    if (
      ["referenceVideo", "referenceVideos", "video", "videos"].includes(role) &&
      asset.kind !== "video"
    )
      throw new Error("参考视频需要视频素材。");
    if (
      ["audio", "audios", "referenceAudio", "referenceAudios"].includes(role) &&
      asset.kind !== "audio"
    )
      throw new Error("音频角色需要音频素材。");
    const pluralRole = (
      {
        image: "images",
        referenceImage: "referenceImages",
        referenceVideo: "referenceVideos",
        audio: "audios",
        referenceAudio: "referenceAudios",
      } as Record<string, string>
    )[role];
    if (
      pluralRole &&
      !w.mapping.some((m) => m.semantic === role) &&
      w.mapping.some((m) => m.semantic === pluralRole)
    )
      role = pluralRole;
    if (
      [
        "image",
        "characterReference",
        "sceneReference",
        "styleReference",
      ].includes(role) &&
      !w.mapping.some((m) => m.semantic === role) &&
      w.mapping.some((m) => m.semantic === "referenceImages")
    )
      role = "referenceImages";
    if (
      role === "audio" &&
      !w.mapping.some((m) => m.semantic === "audio") &&
      w.mapping.some((m) => m.semantic === "referenceAudio")
    )
      role = "referenceAudio";
    if (!plural.has(role) && result.some((r) => r.semantic === role))
      throw new Error("输入角色「" + role + "」重复，请为连线指定不同角色。");
    result.push({
      semantic: role,
      asset,
      edgeId: e.id,
      order: e.data?.order ?? 0,
    });
  }
  for (const required of w.requiredInputs) {
    const found =
      required === "references"
        ? result.some((r) =>
            [
              "referenceImages",
              "referenceVideo",
              "referenceVideos",
              "referenceAudios",
              "characterReference",
              "styleReference",
              "sceneReference",
            ].includes(r.semantic),
          )
        : result.some((r) => r.semantic === required);
    if (!found) throw new Error("缺少必需素材：" + required);
  }
  for (const input of result)
    if (!w.mapping.some((m) => m.semantic === input.semantic))
      throw new Error(
        "当前工作流没有绑定素材角色：" +
          input.semantic +
          "。请调整角色或映射。",
      );
  for (const semantic of new Set(result.map((r) => r.semantic))) {
    const count = result.filter((r) => r.semantic === semantic).length;
    const maps = w.mapping.filter((m) => m.semantic === semantic);
    if (maps.some((m) => m.maxItems !== undefined && count > m.maxItems))
      throw new Error("参考素材数量超过工作流容量。");
    if (
      maps.every((m) => m.index !== undefined) &&
      Array.from({ length: count }, (_, i) => i).some(
        (i) => !maps.some((m) => m.index === i),
      )
    )
      throw new Error("参考素材数量超过工作流映射容量。");
  }
  return result;
}
