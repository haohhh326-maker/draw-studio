import type { RunningHubWorkflowMetadata, WorkflowDefinition } from "../types";
import { sameRunningHubExecutionSource } from "./execution-contract";
import { runningHubWorkflowCategory } from "./classification";

/** Covers are public presentation resources, never authenticated API endpoints. */
export function safeRunningHubCoverUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) return;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return;
    return url.href;
  } catch { return; }
}

export function runningHubWorkflowCover(workflow: WorkflowDefinition): string | undefined {
  return safeRunningHubCoverUrl(workflow.runninghub?.coverUrl);
}

function coverMediaType(url: string, requested: unknown): "image" | "video" {
  if (requested === "image" || requested === "video") return requested;
  return /\.(?:mp4|webm|m4v|mov|ogv|ogg)$/i.test(new URL(url).pathname) ? "video" : "image";
}

export function runningHubWorkflowCoverMediaType(workflow: WorkflowDefinition): "image" | "video" | undefined {
  const url = runningHubWorkflowCover(workflow);
  return url ? coverMediaType(url, workflow.runninghub?.coverMediaType) : undefined;
}

/** Reviewed output bindings determine classification; platform labels are descriptive only. */
export function runningHubWorkflowClassification(workflow: WorkflowDefinition): { family: string; label: string } {
  const kind = runningHubWorkflowCategory(workflow);
  const labels = { image: "图像", video: "视频", audio: "音频", text: "文本", file: "文件" };
  let family = workflow.family;
  if (!kind) return { family: "待确认输出", label: "待确认" };
  if (/^(?:(?:图像|视频|音频|文本)(?:工具|生成|编辑)|待确认输出|通用工具|其他工作流)$/.test(family)) family = labels[kind] + "工具";
  return { family, label: labels[kind] };
}

export function isGenericRunningHubWorkflowName(workflow: WorkflowDefinition): boolean {
  if (!workflow.runninghub) return false;
  const prefix = workflow.name.trim().replace(/\s+/g, " ");
  return ["RunningHub ", "RunningHub 工作流 ", "RunningHub AI 应用 "]
    .some(value => prefix.toLowerCase() === (value + workflow.runninghub!.workflowId).toLowerCase());
}

/** A local title belongs to the user; platform refreshes may still update its original title and cover. */
export function renameRunningHubWorkflow(workflow: WorkflowDefinition, value: string): WorkflowDefinition {
  if (!workflow.runninghub) throw new Error("只能重命名 RunningHub 工作流。");
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) throw new Error("请填写不超过 120 个字符的工作流名称。");
  if (name === workflow.name && workflow.runninghub.nameSource === "custom") return workflow;
  return { ...workflow, name, runninghub: { ...workflow.runninghub, nameSource: "custom" } };
}

/** Updates presentation only; graph, bindings, defaults and user names stay intact. */
export function applyRunningHubWorkflowMetadata(workflow: WorkflowDefinition, metadata: RunningHubWorkflowMetadata): WorkflowDefinition {
  if (!workflow.runninghub) return workflow;
  const current = workflow.runninghub;
  const name = typeof metadata.name === "string" ? metadata.name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) : "";
  const incomingCover = safeRunningHubCoverUrl(metadata.coverUrl);
  const coverUrl = incomingCover ?? safeRunningHubCoverUrl(current.coverUrl);
  const mediaType = coverUrl ? coverMediaType(coverUrl, incomingCover
    ? metadata.coverMediaType
    : metadata.coverUrl === undefined ? metadata.coverMediaType ?? current.coverMediaType : current.coverMediaType) : undefined;
  let nextName = workflow.name;
  let nameSource = current.nameSource;
  if (name) {
    const replaceName = current.nameSource !== "custom" && (!workflow.name.trim() ||
      isGenericRunningHubWorkflowName(workflow) || current.nameSource === "platform" || workflow.name === current.platformName);
    if (replaceName) nextName = name;
    nameSource = replaceName ? "platform" : "custom";
  }
  const platformName = name || current.platformName;
  const platformCategory = metadata.platformCategory && ["image", "video", "audio", "motion"].includes(metadata.platformCategory) ? metadata.platformCategory : current.platformCategory;
  const platformCategoryReader = metadata.platformCategoryReader ?? current.platformCategoryReader;
  if (nextName === workflow.name && platformName === current.platformName && coverUrl === current.coverUrl && mediaType === current.coverMediaType && nameSource === current.nameSource
    && platformCategory === current.platformCategory && platformCategoryReader?.revision === current.platformCategoryReader?.revision && platformCategoryReader?.repository === current.platformCategoryReader?.repository) return workflow;
  const runninghub = { ...current, ...(platformName ? { platformName } : {}), ...(nameSource ? { nameSource } : {}), ...(platformCategory ? { platformCategory } : {}), ...(platformCategoryReader ? { platformCategoryReader } : {}) };
  if (coverUrl) { runninghub.coverUrl = coverUrl; runninghub.coverMediaType = mediaType; }
  else { delete runninghub.coverUrl; delete runninghub.coverMediaType; }
  return { ...workflow, name: nextName, runninghub };
}

function sameRunningHubCatalogSource(left: WorkflowDefinition, right: WorkflowDefinition) {
  const first = left.runninghub, second = right.runninghub;
  if (!first || !second) return false;
  const site = (value: string) => {
    try {
      const url = new URL(value), host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (url.protocol !== "https:" || url.username || url.password || url.port || !["", "/"].includes(url.pathname)
        || url.search || url.hash || !["runninghub.cn", "runninghub.ai"].includes(host)) return;
      return host;
    } catch { return; }
  };
  const firstSite = site(first.baseUrl), secondSite = site(second.baseUrl);
  return !!firstSite && firstSite === secondSite && first.workflowId === second.workflowId
    && (first.kind ?? "workflow") === (second.kind ?? "workflow")
    && (first.apiVersion ?? "v1") === (second.apiVersion ?? "v1");
}

/** A legacy project can refresh presentation but cannot downgrade reviewed execution bindings. */
export function preserveRunningHubWorkflowMetadata(incoming: WorkflowDefinition, existing?: WorkflowDefinition): WorkflowDefinition {
  const previous = existing?.runninghub;
  let current = incoming.runninghub;
  if (current && previous?.bindingMode === "selected" && current.bindingMode !== "selected"
    && sameRunningHubCatalogSource(incoming, existing!)) {
    const retained = structuredClone(existing!);
    incoming = { ...retained, name: incoming.name, runninghub: { ...retained.runninghub!,
      platformName: current.platformName, nameSource: current.nameSource,
      coverUrl: current.coverUrl, coverMediaType: current.coverMediaType,
      platformCategory: current.platformCategory ?? previous.platformCategory,
      platformCategoryReader: current.platformCategoryReader ?? previous.platformCategoryReader,
    } };
    current = incoming.runninghub;
  }
  if (!current || !previous || current.workflowId !== previous.workflowId || current.baseUrl !== previous.baseUrl) return applyRunningHubWorkflowMetadata(incoming, {});
  if (current.canvasParameterKeys === undefined && previous.canvasParameterKeys !== undefined && sameRunningHubExecutionSource(incoming, existing!)) {
    current = { ...current, canvasParameterKeys: [...previous.canvasParameterKeys] };
    incoming = { ...incoming, runninghub: current };
  }
  // Old project exports can omit the catalog's read version. Inherit it only
  // when source, bindings, output contracts and protocol are still identical.
  if (!current.executionContract && previous.executionContract && sameRunningHubExecutionSource(incoming, existing!)) {
    current = { ...current, executionContract: structuredClone(previous.executionContract),
      ...(current.sourceFormat || previous.sourceFormat ? { sourceFormat: current.sourceFormat ?? previous.sourceFormat } : {}),
      ...(current.apiVersionSource || previous.apiVersionSource ? { apiVersionSource: current.apiVersionSource ?? previous.apiVersionSource } : {}) };
    incoming = { ...incoming, runninghub: current };
  }
  const previousCover = safeRunningHubCoverUrl(previous.coverUrl), incomingCover = safeRunningHubCoverUrl(current.coverUrl);
  const hasPresentation = !!(previous.platformName || previousCover || previous.nameSource || previous.platformCategory);
  if (!hasPresentation) return applyRunningHubWorkflowMetadata(incoming, {});
  const runninghub = { ...current,
    ...(current.platformName || previous.platformName ? { platformName: current.platformName || previous.platformName } : {}),
    ...(incomingCover || previousCover ? { coverUrl: incomingCover || previousCover, coverMediaType: incomingCover ? coverMediaType(incomingCover, current.coverMediaType) : coverMediaType(previousCover!, previous.coverMediaType) } : {}),
    ...(current.nameSource || previous.nameSource ? { nameSource: current.nameSource || previous.nameSource } : {}),
    ...(current.platformCategory || previous.platformCategory ? { platformCategory: current.platformCategory || previous.platformCategory } : {}),
    ...(current.platformCategoryReader || previous.platformCategoryReader ? { platformCategoryReader: current.platformCategoryReader || previous.platformCategoryReader } : {}),
  };
  let name = incoming.name;
  const keepCustomName = previous.nameSource === "custom" && current.nameSource === "platform" && sameRunningHubCatalogSource(incoming, existing!);
  if (keepCustomName || current.nameSource !== "custom" && (!name.trim() || isGenericRunningHubWorkflowName(incoming))) {
    name = existing!.name;
    runninghub.nameSource = previous.nameSource;
  } else if (name !== existing!.name && name !== runninghub.platformName) {
    runninghub.nameSource = "custom";
  }
  return applyRunningHubWorkflowMetadata({ ...incoming, name, runninghub }, {});
}
