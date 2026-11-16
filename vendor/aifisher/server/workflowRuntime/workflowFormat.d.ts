// Application boundary types; the adjacent upstream JavaScript is unchanged.
export type UpstreamRecord = Record<string, any>;
export const WORKFLOW_LIMITS: Readonly<{ maxBytes: number; maxNodes: number; maxLinks: number; maxDepth: number }>;
export class WorkflowFormatError extends Error { code: string; details?: unknown }
export function parseWorkflowArtifact(content: string | Uint8Array, options?: unknown): { workflow: UpstreamRecord; format: string; bytes: Buffer; text: string; sourceSha256: string; byteLength: number };
export function detectWorkflowFormat(workflow: unknown): string;
export function normalizeApiWorkflow(workflow: unknown): UpstreamRecord;
export function analyzeWorkflow(workflow: unknown, format: string, options?: { objectInfo?: UpstreamRecord }): UpstreamRecord;
export function createCapabilityProjection(workflow: unknown, objectInfo?: UpstreamRecord): { nodeDefinitions: UpstreamRecord; relevantCapabilityHash: string };
export function sha256Json(value: unknown): string;
export function sha256Bytes(value: unknown): string;
export function canonicalJson(value: unknown): string;
export function compareUiAndApiWorkflows(uiWorkflow: unknown, apiWorkflow: unknown): UpstreamRecord;
