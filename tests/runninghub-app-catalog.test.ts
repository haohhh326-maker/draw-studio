import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../src/types";
import { runningHubAppsForSite, runningHubWorkflowsForSite } from "../src/runninghub/workflows";

const cn = "https://www.runninghub.cn", ai = "https://www.runninghub.ai";
function entry(id: string, baseUrl?: string, kind?: "app" | "workflow"): WorkflowDefinition {
  return { id, name: id, family: "Image", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [],
    parameters: [], mapping: [], output: { nodeId: "1", field: "images", kind: "image" },
    template: { "1": { class_type: "SaveImage", inputs: {} } },
    ...(baseUrl ? { runninghub: { workflowId: "42", baseUrl, ...(kind ? { kind } : {}) } } : {}) };
}

describe("RunningHub AI app settings catalog", () => {
  it("separates app kind and site without changing the legacy site helper or saved records", () => {
    const cloud = entry("cloud"), app = entry("cn-app", cn, "app"), foreign = entry("ai-app", ai, "app");
    const legacy = entry("cn-workflow", cn, "workflow"), untyped = entry("cn-untyped", cn);
    const invalid = entry("invalid-site", "https://unrelated.example", "app");
    const all = [cloud, app, legacy, untyped, foreign, invalid], before = structuredClone(all);
    expect(runningHubAppsForSite(all, "https://runninghub.cn/")).toEqual([app]);
    expect(runningHubAppsForSite(all, ai)).toEqual([foreign]);
    expect(runningHubWorkflowsForSite(all, cn)).toEqual([app, legacy, untyped]);
    expect(all).toEqual(before);
    expect(runningHubAppsForSite([legacy, untyped], cn)).toEqual([]);
  });
});
