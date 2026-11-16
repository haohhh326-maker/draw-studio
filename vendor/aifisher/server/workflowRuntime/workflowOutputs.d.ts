// Application boundary types; the adjacent upstream JavaScript is unchanged.
export class WorkflowOutputError extends Error { code: string; status: number }
export function normalizeHistoryOutputs(input: { history: unknown; promptId: string; executionPlan: unknown }): Array<Record<string, any>>;
export function normalizeAvailableHistoryOutputs(input: { history: unknown; promptId: string; executionPlan: unknown }): Array<Record<string, any>>;
export function classifyHistoryState(history: unknown, promptId: string): Record<string, any>;
export function toOutputCandidateDto(candidate: unknown): Record<string, any>;
