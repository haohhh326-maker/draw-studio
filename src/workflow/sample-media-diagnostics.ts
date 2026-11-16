import type { AifisherWorkflowReadResult } from "./aifisher-reader-client";

/** Sample file names are not environment requirements. Keep ports and links intact. */
export function isSampleMediaValueDiagnostic(read: AifisherWorkflowReadResult, warning: {
  code: string; nodeId?: string; fieldName?: string; targetNodeId?: unknown; classType?: string;
}): boolean {
  if (read.environment !== "comfyui" || warning.code !== "INVALID_INPUT_VALUE" || !warning.fieldName) return false;
  const nodeId = warning.nodeId ?? (typeof warning.targetNodeId === "string" ? warning.targetNodeId : undefined);
  const candidate = read.bindingCandidates.find(item => item.nodeId === nodeId && item.fieldName === warning.fieldName);
  if (candidate?.modelKind) return false;
  if (candidate?.valueType === "ASSET_GROUP" || candidate?.variableAssetGroup !== undefined) return false;
  if (candidate?.control === "asset" && ["image", "mask", "video", "audio"].includes(candidate.mediaKind ?? "")) return true;
  const classType = warning.classType ?? (nodeId ? read.workflow?.[nodeId]?.class_type : undefined);
  const rawDefinition = classType ? read.nodeDefinitions?.[classType] : undefined;
  const definition = rawDefinition && typeof rawDefinition === "object" ? rawDefinition as {
    input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  } : undefined;
  const input = definition?.input;
  const spec = input?.required?.[warning.fieldName] ?? input?.optional?.[warning.fieldName];
  const options = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] as Record<string, unknown> : undefined;
  if (["image_upload", "video_upload", "audio_upload"].some(key => options?.[key] === true)) return true;
  return /Load/i.test(classType ?? "") && /^(?:image|mask|video|audio)(?:_path|_file|_filename)?$/i.test(warning.fieldName);
}
