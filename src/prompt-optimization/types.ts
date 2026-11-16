export type OptimizationLanguage = "zh" | "en";
export type VisionCapability = "vision" | "text" | "unknown";
export const OPTIMIZATION_OUTPUT_TOKEN_LIMITS = Object.freeze({ min: 512, max: 10000, default: 4096 });
export const OPTIMIZATION_CONTEXT_TOKEN_LIMITS = Object.freeze({ min: 2048, max: 100000, default: 16384 });
export type OptimizationSettings = {
  provider: "comfyui" | "openai-compatible";
  connectionSource: "canvas" | "custom";
  baseUrl: string;
  authHeader: string;
  authPrefix: string;
  modelId: string;
  /** Optional separate vision model for OpenAI-compatible services only. */
  visionModelId: string;
  /** ComfyUI visual model selector: the main GGUF's mmproj file. */
  mmproj: string;
  device: "cuda" | "cpu";
  readMedia: boolean;
  /** Maximum generated tokens, not characters or the model's total context. */
  maxTokens: number;
  /** Total ComfyUI model context capacity, including input and generated tokens. */
  contextTokens: number;
  language: OptimizationLanguage;
  skillDirectory: string;
  /** Read-only migration compatibility; optimization never scans loose templates. */
  templateDirectory?: string;
  capabilities: Record<string, VisionCapability>;
  keyConfigured: boolean;
};
export type OptimizationModel = {
  id: string; capability: VisionCapability; available: boolean;
  mmprojCandidates?: string[];
  recommendedMmproj?: string;
  reason?: string;
};
/** Current canvas connection, used for this request only; never saved by the optimizer. */
export type OptimizationConnection = { baseUrl: string; token: string; authHeader: string; authPrefix: string };
export type OptimizationTarget = {
  model: string;
  /** Stable generation-model identity; never a workflow ID or the optimization LLM. */
  modelKey?: string;
  modelIds?: string[];
  /** Verified input/graph capabilities used for conditional writing guidance. */
  features?: string[];
  promptContract?: "creative" | "verbatim" | "fixed-vocabulary" | "utility";
  family: string;
  workflowId: string;
  workflowName: string;
  mode: string;
  kind: string;
  durationSeconds?: number;
};
export type OptimizationReference = {
  nodeId: string;
  edgeId: string;
  title: string;
  kind: string;
  role: string;
  roleLabel: string;
  text?: string;
  images?: { dataUrl: string; timeSeconds?: number }[];
};
export type OptimizationContext = {
  target: OptimizationTarget;
  /** Only this editable positive prompt is replaced. Connected text is context. */
  prompt: string;
  negativePrompt: string;
  /** Workflow text widgets supplied as context; never overwritten by optimization. */
  inputTexts?: { key: string; label: string; text: string; connected: boolean }[];
  references: OptimizationReference[];
  /** Protected mention marker -> serialized atomic mention. */
  mentions: Record<string, string>;
};
export type SkillMatch = {
  id: string;
  name: string;
  level: "exact" | "family" | "task" | "generic";
  warning?: string;
  files?: string[];
};
export type SkillStatus = {
  directory: string;
  skills: { id: string; name: string; description?: string }[];
  warnings: string[];
  error?: string;
  match?: SkillMatch;
};
export type OptimizationResult = {
  prompt: string;
  modelId: string;
  analyzedImages: number;
  skill: SkillMatch;
  warnings: string[];
};
