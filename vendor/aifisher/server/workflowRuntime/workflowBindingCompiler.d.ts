// Application boundary types; the adjacent upstream JavaScript is unchanged.
export class WorkflowBindingError extends Error { code: string; status: number; details?: unknown }
export function deriveBindingCandidates(input: { executionPlan: unknown; nodeDefinitions?: Record<string, any> }): Array<Record<string, any>>;
export function toBindingCandidateDto(candidate: unknown): Record<string, any>;
export function deriveBindingSetBindings(input: { executionPlan: unknown; nodeDefinitions?: Record<string, any>; selections: Record<string, any>[] }): Array<Record<string, any>>;
export function toBindingSetDto(record: Record<string, any>): Record<string, any>;
