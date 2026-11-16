import type { History } from "../comfyui/client";
import { checkedOutput } from "../comfyui/files";
import type { RemoteFile, WorkflowDefinition } from "../types";

const videoFields = new Set(["gifs", "images", "videos", "video", "clips"]);
const videoFilename = /\.(?:mp4|webm|mov|avi|mkv|m4v|flv|mpeg|mpg)$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function videoFiles(value: unknown): RemoteFile[] | undefined {
  const entries = Array.isArray(value) ? value : record(value) ? [value] : [];
  if (!entries.length || entries.some(entry => !record(entry) || typeof entry.filename !== "string" || !videoFilename.test(entry.filename))) return;
  // Retain the standard path/type checks. An alias must never turn an unsafe
  // descriptor into a permitted download or treat an image thumbnail as video.
  return entries.map(entry => checkedOutput(entry as RemoteFile));
}

/** Native RH can return VHS videos under `images` instead of `gifs`. Normalize
 * the receipt for this execution only; saved workflow contracts stay intact.
 * Candidates must belong to the exact mapped node and contain only video files. */
export function normalizeNativeRunningHubOutputFields(history: History, workflow: WorkflowDefinition): History {
  const descriptors = [workflow.output, ...(workflow.additionalOutputs ?? [])];
  const claimedFields = new Map<string, string>();
  let outputs = history.outputs;
  for (const output of descriptors) {
    if (output.kind !== "video" || !videoFields.has(output.field)) continue;
    const node = history.outputs?.[output.nodeId];
    if (!record(node)) continue;
    const original = node[output.field];
    // A present but invalid selected field remains an error; do not conceal it
    // by borrowing an unrelated result from the same node.
    if (original !== undefined && !(Array.isArray(original) && original.length === 0)) continue;
    const candidates = Object.entries(node).flatMap(([field, value]) => {
      if (field === output.field || !videoFields.has(field)) return [];
      if (descriptors.some(other => other.nodeId === output.nodeId && other.field === field)) return [];
      const files = videoFiles(value);
      return files ? [{ field, files }] : [];
    });
    if (candidates.length > 1) {
      throw new Error("RunningHub 输出节点 " + output.nodeId + " 返回多个候选视频字段，无法确定 " + output.field + " 的对应结果，可恢复原任务核对。");
    }
    if (candidates.length !== 1) continue;
    const claim = JSON.stringify([output.nodeId, candidates[0].field]);
    if (claimedFields.has(claim) && claimedFields.get(claim) !== output.field) {
      throw new Error("RunningHub 输出节点 " + output.nodeId + " 的多个输出映射对应同一视频字段，无法确定各自结果，可恢复原任务核对。");
    }
    claimedFields.set(claim, output.field);
    if (outputs === history.outputs) outputs = { ...history.outputs };
    outputs[output.nodeId] = { ...outputs[output.nodeId], [output.field]: candidates[0].files };
  }
  return outputs === history.outputs ? history : { ...history, outputs };
}
