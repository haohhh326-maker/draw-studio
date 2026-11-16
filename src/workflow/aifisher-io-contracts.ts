import type { ApiWorkflow } from "../types";
import { savedOutputContracts } from "./output-contracts";

type Data = Record<string, unknown>;
type OutputCandidate = { nodeId: string; classType?: string; title?: string; outputTypes?: unknown[] };
type AssetCandidate = { nodeId: string; fieldName: string; control?: string; mediaKind?: string | null; connected?: boolean; valueType?: string; variableAssetGroup?: unknown };
type ReadContract = {
  environment: string;
  workflow: ApiWorkflow | null;
  nodeDefinitions?: Record<string, unknown>;
  nodeDefinitionEvidence?: Record<string, { outputNode?: boolean }>;
  analysis: { candidateOutputs?: OutputCandidate[] };
  bindingCandidates?: { nodeId: string; control?: string }[];
  outputEvidence?: { state: string; outputs: unknown[]; candidateNodes?: OutputCandidate[] };
  projection?: unknown;
};
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const previews = new Set(["PreviewImage", "PreviewAny", "easy showAnything", "Image Comparer (rgthree)"]);
// These exact classes have execution/preview side effects, not a saved result.
const auxiliary = new Set(["ModelPreviewOverrideKJ", "忽略多组孤海"]);
function outputNodeEvidence(read: ReadContract, classType: string): unknown {
  if (read.nodeDefinitionEvidence) return read.nodeDefinitionEvidence[classType]?.outputNode;
  // The RunningHub portable projection synthesizes this flag from node names;
  // it is not a remote object_info response and cannot disprove a publisher.
  if (read.environment === "runninghub-workflow") return;
  const definition = read.nodeDefinitions?.[classType];
  return record(definition) ? definition.output_node : undefined;
}

/** Refine canvas ports without changing the unchanged upstream read or API graph. */
export function aifisherPublishedOutputCandidates(read: ReadContract, candidates: OutputCandidate[]): OutputCandidate[] {
  const receipt = (nodeId: string) => read.outputEvidence?.state === "verified"
    && read.outputEvidence.outputs.some(item => record(item) && item.nodeId === nodeId);
  const type = (candidate: OutputCandidate) => read.workflow?.[candidate.nodeId]?.class_type ?? candidate.classType ?? "";
  const all = [...candidates];
  // A completed receipt also proves a custom publisher that static import could
  // not identify. Keep its exact graph node, never manufacture a save node.
  if (read.outputEvidence?.state === "verified") for (const item of read.outputEvidence.outputs) {
    if (!record(item) || typeof item.nodeId !== "string" || typeof item.mediaKind !== "string" || all.some(candidate => candidate.nodeId === item.nodeId)) continue;
    const node = read.workflow?.[item.nodeId];
    if (node) all.push({ nodeId: item.nodeId, classType: node.class_type, title: node._meta?.title ?? node.class_type, outputTypes: [] });
  }
  const declared = all.filter(candidate => {
    if (!read.workflow?.[candidate.nodeId]) return false;
    if (receipt(candidate.nodeId)) return true;
    const classType = type(candidate);
    if (auxiliary.has(classType)) return false;
    // output_node:false is authoritative negative evidence for a name-only
    // candidate. Exact saved-result contracts still work with partial metadata.
    return outputNodeEvidence(read, classType) !== false || !!savedOutputContracts[classType];
  });
  const final = declared.filter(candidate => !previews.has(type(candidate)) || receipt(candidate.nodeId));
  // A preview-only workflow is valid; do not require an added SaveImage node.
  return final.length ? final : declared;
}

/** A reviewed custom terminal publisher may have no static schema at all. */
export function aifisherOutputBindingAllowed(read: ReadContract, nodeId: string): boolean {
  const node = read.workflow?.[nodeId];
  if (!node) return false;
  const candidate = read.analysis.candidateOutputs?.find(item => item.nodeId === nodeId);
  // Explicit review may retain a preview branch; automatic defaults still
  // prefer saved results. A known non-publishing/control node remains rejected.
  if (candidate) return aifisherPublishedOutputCandidates(read, [candidate]).some(output => output.nodeId === nodeId);
  const declared = outputNodeEvidence(read, node.class_type);
  if (declared === false) return false;
  if (declared === true || savedOutputContracts[node.class_type]) return true;
  if (read.bindingCandidates?.some(item => item.nodeId === nodeId && item.control === "asset")) return false;
  // No inference here: only an explicit user contract can opt into this
  // schema-free terminal route, never a node wired into another operation.
  return !Object.values(read.workflow!).some(target => Object.values(target.inputs).some(value =>
    Array.isArray(value) && value.length === 2 && String(value[0]) === nodeId && Number.isInteger(value[1])));
}

/** Tensor sockets and graph edges are not replaceable uploaded-file ports. */
export function aifisherExternalAssetCandidate(read: ReadContract, candidate: AssetCandidate): boolean {
  if (candidate.control !== "asset" || !["image", "mask", "video", "audio"].includes(candidate.mediaKind ?? "") || candidate.connected) return false;
  // Dynamic asset groups retain the original execution contract and its guard.
  if (candidate.valueType === "ASSET_GROUP" || candidate.variableAssetGroup !== undefined) return true;
  const node = read.workflow?.[candidate.nodeId];
  if (!node || !Object.hasOwn(node.inputs, candidate.fieldName)) return false;
  const value = node.inputs[candidate.fieldName];
  if (Array.isArray(value) || value !== null && typeof value === "object") return false;
  if (read.environment === "runninghub-webapp") {
    const projection = read.projection;
    const snapshot = record(projection) && record(projection.snapshot) ? projection.snapshot : undefined;
    return Array.isArray(snapshot?.fields) && snapshot.fields.some(field => record(field)
      && field.nodeId === candidate.nodeId && field.fieldName === candidate.fieldName
      && (field.kind === candidate.mediaKind || field.kind === "mask" && candidate.mediaKind === "image"));
  }
  const definition = read.nodeDefinitions?.[node.class_type];
  const input = record(definition) && record(definition.input) ? definition.input : undefined;
  const required = record(input?.required) ? input.required : undefined, optional = record(input?.optional) ? input.optional : undefined;
  const specification = required?.[candidate.fieldName] ?? optional?.[candidate.fieldName];
  // Missing/conditional schemas remain the upstream reader's responsibility.
  if (!Array.isArray(specification)) return true;
  const options = record(specification[1]) ? specification[1] : {};
  if (["image_upload", "mask_upload", "video_upload", "audio_upload"].some(key => options[key] === true)) return true;
  const declared = specification[0];
  if (Array.isArray(declared)) return true;
  const types = String(declared ?? "").toUpperCase().split(",").map(type => type.trim());
  // A path/string/combo is the loader's writable value; IMAGE/AUDIO/VIDEO/MASK
  // describe in-memory graph sockets, even when an invalid sample is a string.
  return types.includes("STRING") || types.includes("COMBO") || !types.some(type => ["IMAGE", "MASK", "VIDEO", "AUDIO"].includes(type));
}
