import type { AifisherWorkflowReadResult } from "./aifisher-reader-client";
import type { ImportAnalysis, ImportOutputKind } from "./import-analyzer";
import { savedOutputContracts } from "./output-contracts";
import { aifisherPublishedOutputCandidates } from "./aifisher-io-contracts";

const kindLabels: Record<ImportOutputKind, string> = {
  image: "图像工作流", video: "视频工作流", audio: "音频工作流", text: "文本工作流", file: "其他工作流",
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const mediaKind = (value: unknown): value is ImportOutputKind => ["image", "video", "audio", "text", "file"].includes(String(value));

/** Presentation evidence only. Graph socket types and input names do not prove a saved media format. */
export function aifisherOutputPresentation(read: AifisherWorkflowReadResult) {
  const outputs: ImportAnalysis["outputs"] = aifisherPublishedOutputCandidates(read, read.outputEvidence.candidateNodes).map(candidate => {
    const receipts = read.outputEvidence.state === "verified" ? read.outputEvidence.outputs
      .filter(record).filter(item => item.nodeId === candidate.nodeId) : [];
    const receiptKinds = [...new Set(receipts.map(item => item.mediaKind === "json" ? "text" : item.mediaKind).filter(mediaKind))];
    const type = read.workflow?.[candidate.nodeId]?.class_type ?? candidate.classType ?? "";
    // rgthree's comparer delegates to PreviewImage and returns a_images/b_images:
    // https://github.com/rgthree/rgthree-comfy/blob/main/py/image_comparer.py
    const declaredKind = type === "Image Comparer (rgthree)" ? "image" : savedOutputContracts[type]?.kind;
    const kind = receiptKinds.length ? receiptKinds.length === 1 ? receiptKinds[0] : "file" : declaredKind ?? "file";
    // Keep wildcard collection even for a known contract: RunningHub/plugins can
    // publish alternate result keys, and actual receipts must determine file types.
    return { nodeId: candidate.nodeId, label: candidate.title || candidate.classType || candidate.nodeId, kind, field: "*", needsBinding: kind === "file" };
  });
  const evidence = outputs;
  const media = new Set(evidence.map(output => output.kind).filter(kind => kind !== "text"));
  // Ancillary text does not turn image generation into a file workflow. Unknown
  // publishers and genuinely mixed media remain unresolved instead of guessed.
  const kind: ImportOutputKind = media.size === 1 ? [...media][0] : media.size ? "file" : evidence.length ? "text" : "file";
  const primary = evidence.find(output => output.kind === kind) ?? evidence[0] ?? outputs[0];
  return { outputs, kind, categoryLabel: kindLabels[kind], primary };
}
