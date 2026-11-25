import { isTauri } from "@tauri-apps/api/core";
import { projectDatabase } from "../projects/database";
import { writeRecord } from "../projects/storage";
import type { WorkflowDefinition } from "../types";
import { cleanWorkflowCredentials } from "../workflow/credentials";

const catalogKey = "runninghub-workflows";

export function storedRunningHubWorkflows(value: unknown, fallback: WorkflowDefinition[] = []): WorkflowDefinition[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is WorkflowDefinition => !!(item?.runninghub?.workflowId && item.runninghub.baseUrl && item.template))
    .map(workflow => cleanWorkflowCredentials(workflow, { preserveIdentity: true }));
}

/** The browser transaction spans both the read and write, including across tabs. */
export async function updateRunningHubWorkflowCatalog(current: WorkflowDefinition[], update: (catalog: WorkflowDefinition[]) => WorkflowDefinition[]) {
  if (isTauri() || typeof indexedDB === "undefined") {
    const next = update(current);
    if (next !== current) await writeRecord(catalogKey, next);
    return next;
  }

  const transaction = (await projectDatabase()).transaction("records", "readwrite");
  try {
    const previous = storedRunningHubWorkflows(await transaction.store.get(catalogKey), current);
    const next = update(previous);
    if (next !== previous) await transaction.store.put(next, catalogKey);
    await transaction.done;
    return next;
  } catch (reason) {
    await transaction.done.catch(() => {});
    throw reason;
  }
}
