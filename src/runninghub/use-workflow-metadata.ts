import { useEffect, useState } from "react";
import type { WorkflowDefinition } from "../types";
import { useStore } from "../stores/store";
import { RunningHubClient } from "./client";

/** Hydrate published cards without rereading or replacing their execution graph. */
export function useRunningHubWorkflowMetadata(workflows: WorkflowDefinition[]) {
  const connection = useStore(state => state.runningHubConnection);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const catalogKey = JSON.stringify(workflows.filter(w => w.runninghub?.baseUrl === connection.baseUrl)
    .map(w => [w.id, w.runninghub!.workflowId, w.runninghub!.kind ?? "workflow"]));
  useEffect(() => {
    const entries = JSON.parse(catalogKey) as [string, string, "workflow" | "app"][];
    if (!entries.length) { setBusy(false); setError(""); return; }
    const controller = new AbortController();
    setBusy(true); setError("");
    void (async () => {
      let failures = 0;
      try {
        const client = new RunningHubClient(connection);
        for (const [id, platformId, kind] of entries) {
          if (controller.signal.aborted) return;
          try {
            const metadata = await client.getWorkflowMetadata(platformId, kind, controller.signal);
            if (controller.signal.aborted) return;
            await useStore.getState().updateRunningHubWorkflowMetadata(id, metadata);
          } catch { if (controller.signal.aborted) return; failures++; }
        }
        if (failures) setError("部分工作流的名称、封面或分类暂未读取，可点击同步按钮重试。");
      } finally { if (!controller.signal.aborted) setBusy(false); }
    })().catch(() => { if (!controller.signal.aborted) setError("暂时无法同步工作流名称、封面和分类，请稍后重试。"); });
    return () => controller.abort();
  // Changes to saved titles/covers do not create a fetch/persist loop.
  }, [catalogKey, connection.baseUrl, refresh]);
  return { busy, error, refresh: () => setRefresh(value => value + 1) };
}
