import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningHubClient } from "../src/runninghub/client";
import { normalizeRunningHubInstanceType, runningHubInstanceTypeLabel, runningHubInstanceTypes } from "../src/runninghub/instance-types";
import type { ApiWorkflow, Connection, RunningHubInstanceType, WorkflowDefinition } from "../src/types";

const connection: Connection = { name: "RH modes", baseUrl: "https://www.runninghub.cn", token: "mode-test-credential", timeoutMinutes: 1 };
const workflowGraph: ApiWorkflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "flower" } },
  "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};
const appGraph: ApiWorkflow = {
  "1": { class_type: "RunningHubAppInput", inputs: { prompt: "flower" } },
  __rh_app_output: { class_type: "RunningHubAppOutput", inputs: {} },
};
type Route = "workflow-v1" | "app-v1" | "app-v2";
function definition(route: Route, baseUrl = connection.baseUrl): WorkflowDefinition {
  const app = route !== "workflow-v1";
  return {
    id: route, name: route, description: "", family: "test", mode: "text-to-image",
    template: structuredClone(app ? appGraph : workflowGraph), parameters: [], requiredInputs: [], optionalInputs: [],
    mapping: [{ semantic: "prompt", nodeId: "1", field: app ? "prompt" : "text" }],
    output: { nodeId: app ? "__rh_app_output" : "9", field: "images", kind: "image" },
    runninghub: { baseUrl, workflowId: "1234567890123456789", ...(app ? { kind: "app", apiVersion: route === "app-v2" ? "v2" : "v1" } : {}) },
  };
}
function transport() {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), init: init!, body });
    const task = { taskId: "mode-task-" + calls.length, status: "QUEUED" };
    return new Response(JSON.stringify(String(url).includes("/openapi/v2/run/") ? task : { code: 0, data: task }));
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

describe("RunningHub instance selection", () => {
  it("publishes exactly the documented values and requested display labels", () => {
    expect(runningHubInstanceTypes).toEqual([
      { value: "default", label: "Standard" },
      { value: "plus", label: "Plus" },
      { value: "ultra", label: "6000D" },
    ]);
    for (const { value, label } of runningHubInstanceTypes) {
      expect(normalizeRunningHubInstanceType(value)).toBe(value);
      expect(runningHubInstanceTypeLabel(value)).toBe(label);
    }
    expect(normalizeRunningHubInstanceType(undefined)).toBe("default");
    expect(runningHubInstanceTypeLabel()).toBe("Standard");
  });
  it.each([null, "", "standard", "lite", "6000D", "ULTRA", " plus ", 0, {}, ["plus"]])("rejects an unknown execution value without silently downgrading: %j", value => {
    expect(() => normalizeRunningHubInstanceType(value)).toThrow(/运行模式无效/);
    expect(runningHubInstanceTypeLabel(value as RunningHubInstanceType)).toBe("未知模式");
  });

  const cases = (["workflow-v1", "app-v1", "app-v2"] as const).flatMap(route =>
    runningHubInstanceTypes.map(({ value }) => ({ route, value })),
  );
  it.each(cases)("submits $value as a top-level setting for $route without changing the graph or auth protocol", async ({ route, value }) => {
    const { calls } = transport(), workflow = definition(route), prompt = structuredClone(workflow.template);
    const original = structuredClone(prompt);
    const client = new RunningHubClient(connection, crypto.randomUUID(), workflow, value);
    await client.queuePrompt(prompt, "mode-request");
    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0];
    const expectedPath = route === "workflow-v1" ? "/task/openapi/create" : route === "app-v1" ? "/task/openapi/ai-app/run" : "/openapi/v2/run/ai-app/1234567890123456789";
    expect(url).toBe(connection.baseUrl + expectedPath);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer " + connection.token);
    expect(body.instanceType).toBe(value);
    expect(body).not.toHaveProperty("usePersonalQueue"); expect(body).not.toHaveProperty("retainSeconds");
    expect(body).not.toHaveProperty("billingMode");
    if (route === "app-v2") {
      expect(Object.keys(body).sort()).toEqual(["instanceType", "nodeInfoList"]);
      expect(JSON.stringify(body)).not.toContain(connection.token);
    } else {
      expect(body.apiKey).toBe(connection.token);
      expect(body[route === "workflow-v1" ? "workflowId" : "webappId"]).toBe("1234567890123456789");
    }
    if (route === "workflow-v1") expect(JSON.parse(String(body.workflow))).toEqual(original);
    else expect(body).not.toHaveProperty("workflow");
    expect((body.nodeInfoList as { fieldName: string }[]).some(field => field.fieldName === "instanceType")).toBe(false);
    expect(prompt).toEqual(original); expect(workflow.template).toEqual(original);
  });
  it.each(["workflow-v1", "app-v1", "app-v2"] as const)("defaults a missing legacy instance selection to default for %s", async route => {
    const { calls } = transport(), workflow = definition(route);
    await new RunningHubClient(connection, crypto.randomUUID(), workflow).queuePrompt(workflow.template, "legacy-mode");
    expect(calls).toHaveLength(1); expect(calls[0].body.instanceType).toBe("default");
  });
  it.each(["standard", "lite", "6000D", null, ""])("constructs safely but rejects invalid saved mode %j before any submission request", async value => {
    const { fetcher } = transport(), workflow = definition("workflow-v1");
    let client!: RunningHubClient;
    expect(() => { client = new RunningHubClient(connection, crypto.randomUUID(), workflow, value as RunningHubInstanceType); }).not.toThrow();
    await expect(client.queuePrompt(workflow.template, "invalid-mode")).rejects.toMatchObject({ name: "Error", status: "failed", message: expect.stringContaining("尚未提交") });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps two client selections independent and does not reuse a prior mode", async () => {
    const { calls } = transport(), workflow = definition("app-v2");
    const plus = new RunningHubClient(connection, "plus-client", workflow, "plus");
    const ultra = new RunningHubClient(connection, "ultra-client", workflow, "ultra");
    await plus.queuePrompt(workflow.template, "plus-first");
    await ultra.queuePrompt(workflow.template, "ultra");
    await plus.queuePrompt(workflow.template, "plus-again");
    expect(calls.map(call => call.body.instanceType)).toEqual(["plus", "ultra", "plus"]);
  });
  it("preserves the selected official site when sending an instance setting", async () => {
    const { calls } = transport(), global = { ...connection, baseUrl: "https://www.runninghub.ai" };
    const workflow = definition("app-v2", global.baseUrl);
    await new RunningHubClient(global, "global-instance", workflow, "ultra").queuePrompt(workflow.template, "global");
    expect(calls[0].url).toBe(global.baseUrl + "/openapi/v2/run/ai-app/1234567890123456789");
    expect(calls[0].body.instanceType).toBe("ultra");
  });
  it("does not attach instance selection or block original-task timing queries with a corrupt saved mode", async () => {
    const workflow = definition("app-v2");
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ status: "SUCCESS", usage: { taskCostTime: "130" }, results: [{ url: "https://cdn.example/output.png", outputType: "png" }] })));
    vi.stubGlobal("fetch", fetcher);
    const client = new RunningHubClient(connection, "read-only-mode", workflow, "invalid" as RunningHubInstanceType);
    expect(await client.readTaskTiming("original-task")).toEqual({ providerDurationSeconds: 130 });
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/openapi/v2/query");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ taskId: "original-task" });
  });
});
