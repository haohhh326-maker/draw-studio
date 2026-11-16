import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { attachAifisherReadResult, type AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import type { ApiWorkflow } from "../src/types";
import { runningHubAppFromRead, type RunningHubAiApp } from "../src/runninghub/client";
import type { RunningHubWorkflowOptions } from "../src/runninghub/workflows";
import type { RunningHubReaderResult } from "../src/runninghub/upstream-reader";

export async function readRunningHubWorkflowFixture(source: unknown): Promise<RunningHubReaderResult> {
  const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source });
  const read = result as unknown as AifisherWorkflowReadResult;
  if (result.workflow) attachAifisherReadResult(result.workflow as ApiWorkflow, read);
  if (source && typeof source === "object" && !Array.isArray(source)) attachAifisherReadResult(source as ApiWorkflow, read);
  return result as unknown as RunningHubReaderResult;
}

export async function withRunningHubWorkflowReader(source: unknown, options: RunningHubWorkflowOptions) {
  return { ...options, reader: await readRunningHubWorkflowFixture(source) };
}

export async function withRunningHubAppReader(app: RunningHubAiApp): Promise<RunningHubAiApp & { reader: RunningHubReaderResult }> {
  const source = app.rawInfo ?? { appName: app.name, nodeInfoList: app.nodeInfoList };
  const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "fixture-app", source });
  return { ...app, ...runningHubAppFromRead(result as unknown as AifisherWorkflowReadResult), apiVersion: app.apiVersion,
    ...(app.outputKind ? { outputKind: app.outputKind } : {}), reader: result as unknown as RunningHubReaderResult };
}
