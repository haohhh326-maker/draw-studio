import { analyzeWorkflow, createCapabilityProjection, normalizeApiWorkflow, parseWorkflowArtifact, WORKFLOW_LIMITS } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { deriveBindingCandidates } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";
import { normalizeHistoryOutputs, toOutputCandidateDto } from "../vendor/aifisher/server/workflowRuntime/workflowOutputs.js";
import { readUpstreamRunningHubImport, type AifisherRunningHubRemote } from "./aifisher-runninghub-import";
import { workflowImportMediaSchema } from "./workflow-import-media-schema";
import { applyDynamicWorkflowSchema } from "./workflow-import-dynamic-schema";
import { revalidateWorkflowContracts } from "./workflow-import-contract-compat";
import { guardGuiWorkflowCompilation } from "./workflow-import-gui-diagnostics";
import { comfyApiEntries, comfyArtifactRoot } from "../src/workflow/comfy-artifact";

export const AIFISHER_READER_SOURCE = Object.freeze({ repository: "https://github.com/Work-Fisher/AIFISHER", revision: "bdcf3bec054594fcab591952a8c5acef858d6de4" });
type Data = Record<string, any>;
export type AIFisherReaderEnvironment = "comfyui" | "runninghub-workflow" | "runninghub-webapp";
export interface AIFisherWorkflowReaderRequest {
  environment: AIFisherReaderEnvironment;
  source?: unknown;
  objectInfo?: Data;
  remoteId?: string;
  remote?: AifisherRunningHubRemote;
  /** Optional completed ComfyUI receipt; import alone never proves an output media type. */
  history?: Data;
  promptId?: string;
}
export interface AIFisherWorkflowReaderResult {
  environment: AIFisherReaderEnvironment;
  upstream: typeof AIFISHER_READER_SOURCE;
  format: string;
  workflow: Data | null;
  editorWorkflow?: Data;
  analysis: Data;
  bindingCandidates: Data[];
  parameterBindings?: Data[];
  parameterBindingDto?: Data;
  canvasBlueprint?: Data;
  credentialTargets?: Data[];
  runninghubSource?: { rawInfo?: Data; apiProtocol?: string; workflowReadSource?: "official-api-format" | "official-editor-export" | "official-api-export"; credentialTargets?: Data[] };
  nodeDefinitions: Data;
  nodeDefinitionEvidence?: Record<string, { outputNode?: boolean }>;
  projection?: Data;
  category?: "image" | "video" | "audio" | "motion";
  outputEvidence: { state: "unresolved" | "declared" | "verified"; candidateNodes: Data[]; outputs: Data[] };
}
export class AIFisherWorkflowReaderError extends Error {
  constructor(message: string, public code = "AIFISHER_READER_INVALID_REQUEST", public status = 400) { super(message); this.name = "AIFisherWorkflowReaderError"; }
}
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
function artifactText(source: unknown): string {
  if (typeof source === "string") return source;
  if (!record(source)) throw new AIFisherWorkflowReaderError("工作流来源必须为 JSON 对象或原始 JSON 文本。");
  return JSON.stringify(source);
}

function parseLocalArtifact(source: unknown) {
  const text = artifactText(source);
  if (Buffer.byteLength(text) > WORKFLOW_LIMITS.maxBytes) return parseWorkflowArtifact(text);
  let raw: unknown = source;
  if (typeof source === "string") {
    try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch { return parseWorkflowArtifact(text); }
  }
  if (!record(raw)) return parseWorkflowArtifact(text);
  const root = comfyArtifactRoot(raw);
  if (Array.isArray(root.nodes)) return parseWorkflowArtifact(root === raw ? text : artifactText(root));
  const entries = comfyApiEntries(root);
  return parseWorkflowArtifact(root === raw && entries.length === Object.keys(root).length
    ? text : artifactText(Object.fromEntries(entries)));
}

/** The host supplies transport/storage boundaries; all workflow services are full upstream modules. */
export async function readAIFisherWorkflow(input: AIFisherWorkflowReaderRequest, options: { projectRoot?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<AIFisherWorkflowReaderResult> {
  if (!record(input) || !["comfyui", "runninghub-workflow", "runninghub-webapp"].includes(input.environment)) throw new AIFisherWorkflowReaderError("请选择 ComfyUI 或 RunningHub 读取环境。");
  if (input.objectInfo !== undefined && !record(input.objectInfo)) throw new AIFisherWorkflowReaderError("ComfyUI 节点定义必须为对象。");
  // An unavailable/empty catalog is not proof that every authored node is missing.
  if (input.objectInfo && !Object.keys(input.objectInfo).length) input = { ...input, objectInfo: undefined };
  if (input.environment !== "comfyui") {
    const result = await readUpstreamRunningHubImport({ ...input, environment: input.environment }, options);
    const candidateNodes = Array.isArray(result.analysis.candidateOutputs) ? result.analysis.candidateOutputs : [];
    return { environment: input.environment, upstream: AIFISHER_READER_SOURCE, ...result,
      outputEvidence: { state: candidateNodes.length ? "declared" : "unresolved", candidateNodes, outputs: [] } };
  }
  if (input.remote) throw new AIFisherWorkflowReaderError("本地 ComfyUI 读取不接受 RunningHub 远程凭证。");
  const parsed = parseLocalArtifact(input.source);
  const format = parsed.format;
  const analysisInfo = workflowImportMediaSchema(parsed.workflow, format, input.objectInfo);
  let analysis = analyzeWorkflow(parsed.workflow, format, { objectInfo: analysisInfo });
  analysis = guardGuiWorkflowCompilation(parsed.workflow, format, analysis);
  const workflow = format === "comfy-api" ? normalizeApiWorkflow(parsed.workflow) : record(analysis.apiJson) ? analysis.apiJson : null;
  const capability = workflow && input.objectInfo ? createCapabilityProjection(workflow, input.objectInfo) : undefined;
  const nodeDefinitions = capability?.nodeDefinitions ?? {};
  // The temporary import schema never replaces the workstation's capability evidence.
  if (analysisInfo !== input.objectInfo && capability && Object.hasOwn(analysis, "nodeDefinitions")) Object.assign(analysis, capability);
  let bindingCandidates = workflow ? deriveBindingCandidates({ executionPlan: workflow, nodeDefinitions: Object.keys(nodeDefinitions).length ? nodeDefinitions : undefined }) : [];
  if (workflow) ({ analysis, bindingCandidates } = applyDynamicWorkflowSchema(workflow, analysisInfo, analysis, bindingCandidates));
  if (workflow) analysis = { ...analysis, warnings: revalidateWorkflowContracts(workflow, input.objectInfo, analysis.warnings) };
  const candidateNodes = Array.isArray(analysis.candidateOutputs) ? analysis.candidateOutputs : [];
  const outputs = input.history && input.promptId && workflow
    ? normalizeHistoryOutputs({ history: input.history, promptId: input.promptId, executionPlan: workflow }).map(toOutputCandidateDto)
    : [];
  const nodeDefinitionEvidence = Object.fromEntries(Object.entries(input.objectInfo ?? {}).flatMap(([classType, definition]) =>
    record(definition) && typeof definition.output_node === "boolean" ? [[classType, { outputNode: definition.output_node }]] : []));
  return { environment: input.environment, upstream: AIFISHER_READER_SOURCE, format, workflow, analysis, bindingCandidates, nodeDefinitions, nodeDefinitionEvidence,
    outputEvidence: { state: outputs.length ? "verified" : candidateNodes.length ? "declared" : "unresolved", candidateNodes, outputs } };
}
