// Application boundary types; the adjacent upstream JavaScript is unchanged.
export const RUNNINGHUB_WEBAPP_OUTPUT_NODE_ID: string;
export class RunningHubWebAppError extends Error { code: string; status: number }
export function inferRunningHubWebAppCategory(rawInfo: unknown): "image" | "video" | "audio" | "motion";
export function createRunningHubWebAppProjection(remoteId: string, rawInfo: unknown): {
  snapshot: Record<string, any>;
  schemaHash: string;
  executionPlan: Record<string, any>;
  executionPlanHash: string;
  nodeDefinitions: Record<string, any>;
};
