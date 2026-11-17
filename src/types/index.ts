import type { Node, Edge, Viewport } from "@xyflow/react";
import type { PromptDrafts } from "../prompt-optimization/prompt-drafts";
import type { AifisherRawParameterBinding, AifisherParameterBindingDto } from "../workflow/aifisher-reader-client";
export type Kind =
  | "reference"
  | "video"
  | "image-generation"
  | "text"
  | "audio"
  | "tool"
  | "group";
export type MediaKind = "image" | "video" | "audio" | "text" | "file";
export type Role =
  | "auto"
  | "image"
  | "referenceImage"
  | "firstFrame"
  | "lastFrame"
  | "characterReference"
  | "sceneReference"
  | "styleReference"
  | "referenceVideo"
  | "mask"
  | "audio"
  | "referenceAudio"
  | "prompt"
  | `slot:${string}`;
export type Mode =
  | "text-to-image"
  | "image-to-image"
  | "text-to-video"
  | "image-to-video"
  | "first-last-frame"
  | "reference-video"
  | "multi-reference"
  | "text-to-audio"
  | "audio-to-audio"
  | "audio-to-text"
  | "text-tool"
  | "dataset";
export type Phase =
  | "idle"
  | "uploading"
  | "submitting"
  | "queued"
  | "loading"
  | "generating"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type ComputeProvider = "comfyui" | "runninghub" | "runninghub-workflow" | "muse";
export type RunningHubSite = "cn" | "ai";
export type ExecutorType = "comfyui" | "runninghub" | "muse";
export type TaskState = {
  status: Phase;
  progress?: number;
  error?: string;
  details?: string;
  /** Current result transfer or local write stage, separate from generation progress. */
  savingMessage?: string;
  /** Actual ComfyUI execution events, never an estimated workflow percentage. */
  execution?: {
    nodeId?: string;
    nodeType?: string;
    nodeTitle?: string;
    value?: number;
    max?: number;
    cachedNodes?: string[];
    completedNodes?: string[];
    queueRemaining?: number;
  };
};
export type RunningHubInstanceType = "default" | "plus" | "ultra";
export type Generation = {
  prompt: string;
  negativePrompt: string;
  workflowId: string;
  params: Record<string, string | number | boolean>;
  taskId: string | null;
  computeProvider?: ComputeProvider;
  runningHubInstanceType?: RunningHubInstanceType;
  providerSelections?: Partial<Record<ComputeProvider, {
    workflowId: string;
    params: Record<string, string | number | boolean>;
  }>>;
};
export type TextInput = {
  nodeId: string;
  edgeId: string;
  order: number;
  title: string;
  text: string;
};
export type RunningHubTiming = {
  submittedAt?: number;
  remoteFinishedAt?: number;
  /** Execution duration reported by RunningHub; never inferred from local clocks. */
  providerDurationSeconds?: number;
  prepareMs?: number;
  submitMs?: number;
  observeMs?: number;
  downloadMs?: number;
  importMs?: number;
  checkpointMs?: number;
  downloadBytes?: number;
};
export type GenerationTask = TaskState & {
  taskId: string;
  promptId: string | null;
  /** Only set when the generation request is known not to have been submitted. */
  submissionState?: "not-submitted";
  executorType: ExecutorType;
  /** Immutable resource selection for this accepted RunningHub run. */
  runningHubInstanceType?: RunningHubInstanceType;
  requestId: string;
  clientId: string;
  canvasId: string;
  nodeId: string;
  nodeTitle: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  endedAt?: number;
  runningHubTiming?: RunningHubTiming;
  muse?: { conversationUrl?: string };
  connection: Omit<Connection, "token">;
  workflow: WorkflowDefinition;
  projectId?: string;
  staging?: {
    inputSubfolder: string;
    outputPrefix: string;
    uploads: Record<string, UploadedInput>;
  };
  executionWorkflow?: ApiWorkflow;
  remoteOutputs?: RemoteFile[];
  remoteOutputKinds?: Record<string, MediaKind>;
  remoteAutomaticFiles?: string[];
  outputWarnings?: string[];
  outputText?: string;
  outputTextAsset?: Asset;
  outputTextFirst?: boolean;
  downloadedOutputs?: { file: RemoteFile; asset: Asset }[];
  input: {
    prompt: string;
    negativePrompt: string;
    texts?: TextInput[];
    params: Generation["params"];
    assets: {
      semantic: string;
      asset: Asset;
      edgeId: string;
      order?: number;
    }[];
  };
  outputs: string[];
};
export type RemoteFile = {
  filename: string;
  /** Signed RunningHub result URL; never append connection credentials. */
  url?: string;
  subfolder?: string;
  type?: "input" | "output" | "temp";
  /** Result provenance; these fields do not change the downloaded file's identity. */
  sourceNodeId?: string;
  sourceField?: string;
  width?: number;
  height?: number;
};
export type UploadedInput = {
  name: string;
  subfolder: string;
  type: "input";
  inputName: string;
};
export const idleTask: TaskState = { status: "idle" };
export type NodeData = {
  title: string;
  kind: Kind;
  assetId?: string;
  /** Local edits may undo their asset replacement while generation task state stays current. */
  mediaEdit?: { assetId: string; taskId: string | null };
  text?: string;
  /** Both editable versions travel with project saves, exports and canvas history. */
  promptDrafts?: Partial<Record<"generation" | "text", PromptDrafts>>;
  generation?: Generation;
  generationFeedback?: TaskState;
  [key: string]: unknown;
};
export type CanvasNode = Node<NodeData, "media" | "group">;
export type CanvasEdge = Edge<{ role: Role; order: number }>;
/** Recovery records only. Retired tool data never enters the canvas or task executor. */
export type RetiredToolArchive = {
  version: 1;
  executable: false;
  snapshots: {
    projectFields?: Record<string, unknown>;
    canvasFields?: Record<string, unknown>;
    nodes?: Record<string, unknown>[];
    edges?: CanvasEdge[];
    nodeFields?: { nodeId: string; fields: Record<string, unknown> }[];
  }[];
};
export type RetiredTools = { director?: RetiredToolArchive; [key: string]: unknown };
export type Asset = {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  createdAt: number;
  text?: string;
  width?: number;
  height?: number;
  /** Generated results enter the library only when the user adds them. */
  inLibrary?: boolean;
  /** User-defined library grouping; independent from workflow and media types. */
  libraryCategory?: string;
};
export type Canvas = {
  id: string;
  name: string;
  sceneId: string;
  kind?: "standard";
  retiredTools?: RetiredTools;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
};
export type HistoryEntry = {
  runningHubInstanceType?: RunningHubInstanceType;
  id: string;
  canvasId: string;
  nodeId: string;
  nodeTitle: string;
  workflowId: string;
  prompt: string;
  negativePrompt: string;
  params: Generation["params"];
  inputs: { assetId: string; role: string }[];
  outputs: string[];
  promptId: string;
  createdAt: number;
};
export type Project = {
  version: 2;
  id: string;
  name: string;
  scenes: { id: string; name: string }[];
  canvases: Canvas[];
  activeCanvasId: string;
  assets: Record<string, Asset>;
  tasks: Record<string, GenerationTask>;
  history: HistoryEntry[];
  retiredTools?: RetiredTools;
  updatedAt: number;
};
export type Parameter = {
  key: string;
  label: string;
  type: "number" | "text" | "select" | "boolean";
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  numericType?: "integer" | "float";
  advanced?: boolean;
  multiline?: boolean;
  required?: boolean;
  options?: string[];
  optionLabels?: Record<string, string>;
  optionValues?: Record<string, string | number | boolean>;
  group?: string;
  model?: boolean;
  secret?: boolean;
  inputText?: boolean;
  description?: string;
  /** Exact AIFISHER binding control, kept separate from canvas layout hints. */
  sourceControl?: { kind: string; valueType: string; order: number };
};
export type ApiWorkflow = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;
export type Mapping = {
  semantic: string;
  nodeId: string;
  field: string;
  index?: number;
  /** WAS Image Load resolves paths from the ComfyUI working directory. */
  pathMode?: "comfy-input";
  serialization?: "json-paths";
  maxItems?: number;
};
export type MediaInputPolicy = {
  optionalSemantics: string[];
  removals: { semantic: string; nodeId: string; field: string }[];
  groups: { nodeId: string; label: string; minimum: number; fields: string[]; targets?: string[] }[];
};
export type CredentialField = {
  id: string; nodeId: string; field: string; label: string; required: boolean; parameterKey?: string;
};
export type RunningHubWorkflowMetadata = {
  name?: string; coverUrl?: string; coverMediaType?: "image" | "video";
  platformCategory?: "image" | "video" | "audio" | "motion";
  platformCategoryReader?: { repository: string; revision: string };
};
export type RunningHubBindingContract = {
  nodeId: string; classType: string; field: string;
  inputShape: "scalar" | "link" | "structured";
  valueType?: "string" | "number" | "boolean" | "null";
};
export type RunningHubPublicFieldContract = {
  nodeId: string; fieldName: string; type: string; required: boolean; secret: boolean;
  options?: unknown; min?: number; max?: number; step?: number;
  mediaEmptyValue?: string | null;
};
export type RunningHubExecutionContract = {
  version: 1; scope: "full-graph" | "public-inputs"; sourceHash: string;
  bindingHash?: string;
  nodeCount: number; publicFieldCount?: number;
  nodes: { nodeId: string; classType: string }[];
  targets: RunningHubBindingContract[];
  publicSchema?: { hash: string; fields: RunningHubPublicFieldContract[] };
};
export type WorkflowDefinition = {
  id: string;
  /** Muse website account operation; never a ComfyUI graph. */
  muse?: { kind: "image" | "video" };
  /** Provenance of the unchanged upstream reader; no credentials or raw responses. */
  importReader?: {
    environment: "comfyui" | "runninghub-workflow" | "runninghub-webapp";
    repository: string; revision: string; format: string; compileStatus: string;
    category?: "image" | "video" | "audio" | "motion";
  };
  /** A user-added RunningHub workflow, scoped to its API site. */
  runninghub?: {
    workflowId: string; baseUrl: string; kind?: "workflow" | "app"; apiVersion?: "v1" | "v2"; sourceFormat?: "api-workflow" | "app-inputs";
    apiVersionSource?: "explicit" | "platform";
    mediaInputs?: { nodeId: string; field: string; required: boolean; emptyValue?: string | null }[];
    executionContract?: RunningHubExecutionContract;
    /** Selected bindings alone may override the retained remote workflow defaults. */
    bindingMode?: "selected";
    /** Explicit opt-in for sending the full graph, otherwise submit ID and bindings. */
    includeWorkflowJson?: boolean;
    /** Remote workflow links explicitly use the consumer RH coin / wallet account. */
    billingMode?: "consumer";
    /** Chosen canvas controls; older definitions used these only for visibility. */
    canvasParameterKeys?: string[];
    /** Version 2 consumes AIFISHER's complete binding/control contract. */
    parameterSchemaVersion?: 2;
    sourceBindings?: AifisherRawParameterBinding[];
    sourceBindingDto?: AifisherParameterBindingDto;
    sourceBlueprint?: Record<string, unknown>;
    platformName?: string; coverUrl?: string; coverMediaType?: "image" | "video"; nameSource?: "platform" | "custom";
    platformCategory?: "image" | "video" | "audio" | "motion";
    platformCategoryReader?: { repository: string; revision: string };
  };
  credentials?: CredentialField[];
  library?: {
    sourcePath: string; folder: string; runnerType?: string; executionIssue?: string;
    importStatus?: "pending" | "ready";
    diagnostics?: { code: string; message: string; nodeId?: string; classType?: string; field?: string }[];
    environmentReport?: import("../workflow/import-environment-diagnostics").ImportEnvironmentReport;
  };
  inputSlots?: { semantic: string; label: string; kind: "image" | "video" | "audio"; required: boolean }[];
  /** Schema-driven imports omit unused optional branches instead of loading example files. */
  mediaInputMode?: "schema" | "explicit";
  mediaInputPolicy?: MediaInputPolicy;
  dynamicReferences?: {
    constraints: { minTotal: number; minimumByType?: Record<string, number> };
    binding: { targetNodeId: string };
    routes: Record<string, { maxItems: number; prototypeNodeIds: string[]; pathBinding: { nodeId: string; path: string }; output?: { nodeId: string; index: number }; videoOutput?: { nodeId: string; index: number }; targetInputPrefix: string; targetInputStartIndex?: number; pairedAudioInputPrefix?: string }>;
  };
  publicReference?: {
    url: string;
    note: string;
    modelDirectory: string;
    modelNames: string[];
  };
  original?: {
    id: string;
    version: string;
    folder: string;
    configFile: string;
    configSha256: string;
    executionFile: string;
    executionStatus: "encrypted" | "plain" | "missing";
    executionSha256: string;
    inputs: { id: string; name: string; dataType: string; required?: boolean; description?: string; binding?: unknown }[];
    models: { name: string; relativePath?: string; required?: boolean }[];
    docsUrl: string;
    promptPlaceholder: string;
    promptBinding?: unknown;
    parameterBindings: Record<string, unknown>;
  };
  directory?: {
    version: 2;
    canvas: "music" | "image" | "video" | "text";
    seriesId: string;
    bindingKey: string;
    bindingStatus: "pending" | "bound";
  };
  family: string;
  /** Declared generation model identities, e.g. an API execution.model; never optimizer models or credentials. */
  generationModels?: string[];
  name: string;
  description: string;
  promptRequired?: boolean;
  defaultPrompt?: string;
  verification?: "not-run";
  source?: {
    file: string;
    sha256: string;
    sourceUrl: string;
    format: string;
    models: string[];
    missingNodes: string[];
    missingModels: string[];
    issues: string[];
    nodeIssues?: Record<string, string[]>;
    excluded?: boolean;
  };
  outputChoices?: (WorkflowDefinition["output"] & {
    label: string;
    issues: string[];
  })[];
  mode: Mode;
  requiredInputs: string[];
  optionalInputs: string[];
  parameters: Parameter[];
  mapping: Mapping[];
  output: {
    nodeId: string;
    field: string;
    kind: MediaKind;
    prefix?: { nodeId: string; field: string };
  };
  additionalOutputs?: WorkflowDefinition["output"][];
  template?: ApiWorkflow;
};
export type Connection = {
  name: string;
  baseUrl: string;
  token: string;
  authHeader: string;
  authPrefix: string;
  timeoutMinutes: number;
  autodl?: { instanceUuid: string };
};
export const busyPhases: Phase[] = [
  "uploading",
  "submitting",
  "queued",
  "loading",
  "generating",
  "saving",
];
export const roleLabels: Record<Exclude<Role, `slot:${string}`>, string> = {
  auto: "自动分配",
  prompt: "提示词",
  image: "主图",
  referenceImage: "参考图",
  firstFrame: "首帧",
  lastFrame: "尾帧",
  characterReference: "角色参考",
  sceneReference: "场景参考",
  styleReference: "风格参考",
  referenceVideo: "参考视频",
  mask: "蒙版",
  audio: "音频",
  referenceAudio: "参考音频",
};
export const modeLabels: Record<Mode, string> = {
  "text-to-image": "文生图",
  "image-to-image": "图生图",
  "text-to-video": "文生视频",
  "image-to-video": "图生视频",
  "first-last-frame": "首尾帧视频",
  "reference-video": "参考视频",
  "multi-reference": "多参考视频",
  "text-to-audio": "文本生成音频",
  "audio-to-audio": "参考音频生成",
  "audio-to-text": "音频转写",
  "text-tool": "文本处理",
  dataset: "数据集制作",
};
export const phaseLabels: Record<Phase, string> = {
  idle: "等待创作",
  uploading: "上传素材",
  submitting: "提交任务",
  queued: "排队中",
  loading: "开始执行",
  generating: "执行中",
  saving: "保存结果",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
  interrupted: "等待恢复",
};
