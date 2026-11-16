import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWorkflowOutputs } from "../src/comfyui/client";
import { RunningHubClient } from "../src/runninghub/client";
import type { Connection, RemoteFile, WorkflowDefinition } from "../src/types";

const connection: Connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token: "fixture-key", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 2 };
const definition: WorkflowDefinition = {
  id: "rh.multiple", name: "Normal and enlarged", description: "", family: "Fixture", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [],
  output: { nodeId: "9", field: "images", kind: "image" }, additionalOutputs: [{ nodeId: "11", field: "images", kind: "image" }],
  template: { "1": { class_type: "LoadImage", inputs: { image: "input.png" } }, "9": { class_type: "SaveImage", inputs: {} }, "11": { class_type: "SaveImage", inputs: {} } },
  runninghub: { workflowId: "123456789", baseUrl: connection.baseUrl },
};

async function receipt(outputs: unknown[], workflow = definition, v2 = false) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(v2 ? { status: "SUCCESS", results: outputs } : { code: 0, data: outputs })));
  vi.stubGlobal("fetch", fetcher);
  const history = await new RunningHubClient(connection, "multi-output-test", workflow)
    .waitForCompletion("accepted-task", () => {}, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + (v2 ? "/openapi/v2/query" : "/task/openapi/outputs"));
  return history;
}

afterEach(() => vi.unstubAllGlobals());

describe("RunningHub multi-output result receipts", () => {
  it.each(["workflow", "app"] as const)("preserves normal and enlarged real publisher IDs for a %s", async kind => {
    const workflow = { ...definition, runninghub: { ...definition.runninghub!, kind } };
    const history = await receipt([
      { nodeId: "9", fieldName: "images", fileUrl: "https://cdn.example/normal.png", fileType: "png", width: 768, height: 512 },
      { node_id: 11, field_name: "images", fileUrl: "https://cdn.example/enlarged.png", fileType: "png", width: "3072", height: "2048" },
    ], workflow);
    expect(Object.keys(history.outputs)).toEqual(["9", "11"]);
    expect(history.outputs["9"].images).toEqual([expect.objectContaining({ sourceNodeId: "9", sourceField: "images", width: 768, height: 512 })]);
    expect(history.outputs["11"].images).toEqual([expect.objectContaining({ sourceNodeId: "11", sourceField: "images", width: 3072, height: 2048 })]);
    expect(collectWorkflowOutputs(history, workflow).files.map(file => file.filename).sort()).toEqual(["enlarged.png", "normal.png"]);
  });

  it.each(["__rh_app_output", "fisherai_webapp_output"])("keeps every underlying publisher on the virtual AI-app contract %s", async nodeId => {
    const workflow: WorkflowDefinition = { ...definition, output: { nodeId, field: "files", kind: "image" }, additionalOutputs: [],
      template: { [nodeId]: { class_type: "RunningHubAppOutput", inputs: {} } }, runninghub: { ...definition.runninghub!, kind: "app" } };
    const history = await receipt([
      { nodeId: "9", fileUrl: "https://cdn.example/normal.jpg", fileType: "jpg" },
      { nodeId: "11", fileUrl: "https://cdn.example/enlarged.jpg", fileType: "jpg", width: 3072, height: 2048 },
    ], workflow);
    expect(Object.keys(history.outputs)).toEqual([nodeId]);
    const files = history.outputs[nodeId].files as RemoteFile[];
    expect(files.map(file => file.sourceNodeId)).toEqual(["9", "11"]);
    expect(collectWorkflowOutputs(history, workflow).files.map(file => file.filename).sort()).toEqual(["enlarged.jpg", "normal.jpg"]);
  });

  it("accepts every documented V2 url/outputType result without inventing source node IDs", async () => {
    const nodeId = "fisherai_webapp_output";
    const workflow: WorkflowDefinition = { ...definition, output: { nodeId, field: "files", kind: "image" }, additionalOutputs: [],
      template: { [nodeId]: { class_type: "RunningHubAppOutput", inputs: {} } }, runninghub: { ...definition.runninghub!, kind: "app", apiVersion: "v2" } };
    const history = await receipt([{ url: "https://cdn.example/a.jpg", outputType: "jpg" }, { url: "https://cdn.example/b.jpg", outputType: "jpg" }], workflow, true);
    const files = collectWorkflowOutputs(history, workflow).files;
    expect(files).toHaveLength(2);
    expect(files.every(file => !Object.hasOwn(file, "sourceNodeId"))).toBe(true);
  });

  it("retains unknown publisher IDs separately instead of disguising them as declared outputs", async () => {
    const workflow = { ...definition, runninghub: { ...definition.runninghub!, kind: "app" as const } };
    const history = await receipt([
      { nodeId: "1", fileUrl: "https://cdn.example/input.png", fileType: "png" },
      { nodeId: "9", fileUrl: "https://cdn.example/normal.png", fileType: "png" },
      { nodeId: "11", fileUrl: "https://cdn.example/enlarged.png", fileType: "png" },
    ], workflow);
    expect(history.outputs["1"].files).toEqual([expect.objectContaining({ sourceNodeId: "1", filename: "input.png" })]);
    expect(collectWorkflowOutputs(history, workflow).files.map(file => file.filename).sort()).toEqual(["enlarged.png", "normal.png"]);
  });

  it("does not guess an output node when several real publishers omit their IDs", async () => {
    await expect(receipt([{ fileUrl: "https://cdn.example/unknown.png", fileType: "png" }])).rejects.toThrow("缺少输出节点 ID");
  });

  it("keeps the sole-output fallback when an upstream contract repeats the primary descriptor", async () => {
    const workflow = { ...definition, additionalOutputs: [{ ...definition.output }] };
    const history = await receipt([{ fileUrl: "https://cdn.example/result.png", fileType: "png" }], workflow);
    expect(history.outputs["9"].images).toEqual([expect.objectContaining({ filename: "result.png" })]);
    expect((history.outputs["9"].images as RemoteFile[])[0].sourceNodeId).toBeUndefined();
    expect(collectWorkflowOutputs(history, workflow).files).toHaveLength(1);
  });

  it("honors distinct fields on the same node and preserves an undeclared field separately", async () => {
    const workflow: WorkflowDefinition = { ...definition, additionalOutputs: [{ nodeId: "9", field: "upscaled", kind: "image" }] };
    const history = await receipt([
      { nodeId: "9", fieldName: "images", fileUrl: "https://cdn.example/normal.png" },
      { nodeId: "9", fieldName: "upscaled", fileUrl: "https://cdn.example/enlarged.png" },
      { nodeId: "9", fieldName: "input", fileUrl: "https://cdn.example/input.png" },
    ], workflow);
    expect((history.outputs["9"].upscaled as RemoteFile[])[0].sourceField).toBe("upscaled");
    expect((history.outputs["9"].input as RemoteFile[])[0].sourceField).toBe("input");
    expect(collectWorkflowOutputs(history, workflow).files.map(file => file.filename).sort()).toEqual(["enlarged.png", "normal.png"]);
  });

  it("preserves explicit input storage evidence and ignores invalid dimensions", async () => {
    const workflow: WorkflowDefinition = { ...definition, additionalOutputs: [] };
    const history = await receipt([
      { nodeId: "9", type: "input", fileUrl: "https://cdn.example/input.png", width: -1, height: "NaN" },
      { nodeId: "9", type: "image", fileUrl: "https://cdn.example/input-query.png?type=input", width: "1.5", height: true },
      { nodeId: "9", fileUrl: "https://cdn.example/result.png", width: 2048, height: "1024" },
    ], workflow);
    const files = history.outputs["9"].images as RemoteFile[];
    expect(files.map(file => file.type)).toEqual(["input", "input", "output"]);
    expect(files.slice(0, 2).every(file => file.width === undefined && file.height === undefined)).toBe(true);
    expect(files[2]).toMatchObject({ width: 2048, height: 1024 });
  });

  it("does not expose prototype entries as publisher or field containers", async () => {
    const history = await receipt([{ nodeId: "__proto__", fieldName: "constructor", fileUrl: "https://cdn.example/result.png" }]);
    expect(Object.getPrototypeOf(history.outputs)).toBeNull();
    expect(history.outputs.__proto__.constructor).toEqual([expect.objectContaining({ sourceNodeId: "__proto__", sourceField: "constructor" })]);
    expect(({} as Record<string, unknown>).filename).toBeUndefined();
  });
});
