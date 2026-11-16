import type { ApiWorkflow } from "../types";
import { readableRunningHubError } from "../runninghub/error-message";

export type AifisherReadEnvironment = "comfyui" | "runninghub-workflow" | "runninghub-webapp";
export type AifisherWorkflowReadRequest = {
  environment: AifisherReadEnvironment;
  source?: unknown;
  objectInfo?: Record<string, unknown>;
  remoteId?: string;
  remote?: { baseUrl: string; remoteId: string; apiKey: string; protocol?: "legacy-webapp-v1" | "ai-app-v2" };
};
export type AifisherBindingCandidate = {
  id: string; nodeId: string; classType: string; nodeTitle: string; fieldName: string;
  value: unknown; valueType: string; required: boolean; connected: boolean;
  control: string; mediaKind: string | null; modelKind: string | null;
  options: unknown[] | null; minimum: number | null; maximum: number | null; step: number | null;
  confidence?: string;
  [key: string]: unknown;
};
export type AifisherOutputCandidate = { nodeId: string; classType: string; title: string; outputTypes: unknown[] };
export type AifisherControlKind = "text" | "textarea" | "number" | "slider" | "toggle" | "select" | "seed" | "asset";
export type AifisherBindingPresentation = { section: string; order: number; advanced: boolean };
export type AifisherSeedPolicy = { mode: "fixed" | "random" | "increment" | "decrement"; value?: number; step?: number };
export type AifisherRawBindingControl = {
  kind: AifisherControlKind;
  mediaKind: string | null;
  required: boolean;
  minimum: number | null; maximum: number | null; step: number | null;
  options: (string | number | boolean)[] | null;
  multiple: boolean;
  minimumItems?: number; maximumItems?: number; capacity?: unknown;
  /** Source defaults can also be structured JSON; consumers must honor kind. */
  defaultValue?: unknown;
};
export type AifisherRawParameterBinding = {
  id: string; key: string; label: string; description: string;
  target: { nodeId: string; expectedClassType: string; fieldName: string; expectedValueType: string };
  control: AifisherRawBindingControl;
  presentation: AifisherBindingPresentation;
  variableAssetGroup?: Record<string, unknown>;
};
export type AifisherPublicParameterBinding = Omit<AifisherRawParameterBinding, "target" | "variableAssetGroup" | "control"> & {
  control: Omit<AifisherRawBindingControl, "options"> & {
    options: { id: string; label: string }[];
    hasDefault: boolean;
  };
};
export type AifisherParameterBindingDto = {
  bindings: AifisherPublicParameterBinding[];
  id?: string; definitionId?: string; definitionRevision?: number; executionPlanHash?: string;
  revision?: number; previousBindingSetId?: string | null; name?: string; bindingSetHash?: string; createdAt?: string;
};
export type AifisherWorkflowReadResult = {
  environment: AifisherReadEnvironment;
  upstream: { repository: string; revision: string };
  format: string;
  workflow: ApiWorkflow | null;
  analysis: {
    format: string; compileStatus: string; nodeCount: number; linkCount: number;
    candidateBindings: AifisherBindingCandidate[]; candidateOutputs: AifisherOutputCandidate[];
    warnings: { code: string; nodeId?: string; classType?: string; fieldName?: string; [key: string]: unknown }[];
    requirements: { nodeTypes: string[]; models: { type: string; name: string }[] };
    [key: string]: unknown;
  };
  bindingCandidates: AifisherBindingCandidate[];
  parameterBindings?: AifisherRawParameterBinding[];
  parameterBindingDto?: AifisherParameterBindingDto;
  nodeDefinitions?: Record<string, unknown>;
  /** Original runtime flags, before AIFISHER's capability projection defaults. */
  nodeDefinitionEvidence?: Record<string, { outputNode?: boolean }>;
  projection?: Record<string, unknown>;
  canvasBlueprint?: Record<string, unknown>;
  runninghubSource?: { rawInfo?: Record<string, unknown>; apiProtocol?: string };
  credentialTargets?: { nodeId: string; fieldName: string }[];
  category?: "image" | "video" | "audio" | "motion";
  outputEvidence: { state: string; candidateNodes: AifisherOutputCandidate[]; outputs: unknown[] };
};

const reads = new WeakMap<ApiWorkflow, AifisherWorkflowReadResult>();
/** Keep the reader's exact output separate from canvas presentation objects. */
export function attachAifisherReadResult(graph: ApiWorkflow, result: AifisherWorkflowReadResult) {
  reads.set(graph, result);
  return graph;
}
export function aifisherReadResultFor(graph: ApiWorkflow) { return reads.get(graph); }

/** Parsing is performed by the unchanged upstream Node modules on our local service. */
export async function readAifisherWorkflow(request: AifisherWorkflowReadRequest, signal?: AbortSignal): Promise<AifisherWorkflowReadResult> {
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-reader", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(readableRunningHubError(result.error || "AIFISHER 工作流读取失败（HTTP " + response.status + "）。"));
    Object.assign(error, { status: response.status, code: result.code });
    throw error;
  }
  if (result.environment !== request.environment || result.upstream?.revision !== "bdcf3bec054594fcab591952a8c5acef858d6de4"
    || !result.analysis || !Array.isArray(result.bindingCandidates) || !result.outputEvidence)
    throw new Error("本机服务未返回匹配的 AIFISHER 源码读取结果。");
  if (request.environment !== "comfyui" && (!Array.isArray(result.parameterBindings) || !Array.isArray(result.parameterBindingDto?.bindings)))
    throw new Error("本机服务未返回完整的 AIFISHER 参数绑定和控件配置。");
  if (result.workflow) attachAifisherReadResult(result.workflow, result);
  return result;
}
