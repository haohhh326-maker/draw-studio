import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { createRunningHubWebAppProjection } from "../vendor/aifisher/server/workflowRuntime/runningHubWebApp.js";
import { analyzeRunningHubUpstream, buildRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { prepareRunningHubWorkflow, runningHubAppGraph } from "../src/runninghub/workflows";
import { analyzeRunningHubImport } from "../src/runninghub/import-analysis";
import { generationParameterSurface } from "../src/generation/parameter-actions";

const appId = "2092444522851684354";
const ratios = ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)", "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"];
const publicApp = {
  appName: "MiniMax H3_电影质感V2", tags: [{ name: "文生视频" }], nodeInfoList: [
    { nodeId: "199", nodeName: "LoadImage", fieldName: "image", fieldType: "IMAGE", description: "image", fieldValue: "None", fieldData: '[["None","reference.png"],{"image_upload":true}]' },
    { nodeId: "188", nodeName: "LoadImage", fieldName: "image", fieldType: "IMAGE", description: "image", fieldValue: "None", fieldData: '[["None","reference.png"],{"image_upload":true}]' },
    { nodeId: "228", fieldName: "aspect_ratio", fieldType: "LIST", description: "aspect_ratio", fieldValue: "16:9 (Widescreen)", fieldData: JSON.stringify([ratios, { default: "1:1 (Square)" }]) },
    { nodeId: "228", fieldName: "megapixels", fieldType: "FLOAT", description: "megapixels", fieldValue: "1", fieldData: '["FLOAT",{"default":1,"min":0.1,"max":16,"step":0.1}]' },
    { nodeId: "227", fieldName: "value", fieldType: "FLOAT", description: "value", fieldValue: "10", fieldData: '["FLOAT",{"step":0.1}]' },
    { nodeId: "166", fieldName: "strength_model", fieldType: "FLOAT", description: "电影感lora强度", fieldValue: "0.85", fieldData: '["FLOAT",{"default":1,"min":-100,"max":100,"step":0.01}]' },
    { nodeId: "238", fieldName: "value", fieldType: "STRING", description: "value", fieldValue: "[sanitized public prompt]", fieldData: '["STRING",{"multiline":true}]' },
  ],
};
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const adapterReader = (value: unknown) => value as RunningHubReaderResult;
type ReaderRequest = Parameters<typeof readAIFisherWorkflow>[0];
type ReaderOptions = NonNullable<Parameters<typeof readAIFisherWorkflow>[1]>;

describe("RunningHub has one original AIFISHER read path", () => {
  it("uses the original CN client GET contract to obtain public fields without a browser parser", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://www.runninghub.cn");
      expect(url.pathname).toBe("/api/webapp/apiCallDemo");
      expect(url.searchParams.get("webappId")).toBe(appId);
      expect(url.searchParams.has("apiKey")).toBe(true);
      expect(init?.method).toBe("GET");
      return json({ code: 0, data: publicApp });
    });
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: "fixture-local-test-key",
    } } as unknown as ReaderRequest, { fetcher } as unknown as ReaderOptions);
    expect(fetcher).toHaveBeenCalled();
    expect(result.workflow).toEqual(createRunningHubWebAppProjection(appId, publicApp).executionPlan);
    expect(result.bindingCandidates).toHaveLength(7);
  });

  it("uses the original AI client public detail POST instead of the CN apiCallDemo contract", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://www.runninghub.ai");
      expect(url.pathname).toBe("/api/webapp/detail");
      expect(url.search).toBe("");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ webappId: appId });
      return json({ code: 0, data: { id: appId, name: publicApp.appName, tags: publicApp.tags, inputNodes: publicApp.nodeInfoList } });
    });
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.ai", remoteId: appId, apiKey: "fixture-local-test-key",
    } } as unknown as ReaderRequest, { fetcher } as unknown as ReaderOptions);
    expect(fetcher).toHaveBeenCalled();
    expect(result.workflow).toEqual(createRunningHubWebAppProjection(appId, publicApp).executionPlan);
    expect(result.parameterBindings?.every(binding => binding.key.startsWith("field_"))).toBe(true);
  });

  it("reads remote native workflows only through the original read-only API-format endpoint", async () => {
    const source = { "1": { class_type: "PrimitiveString", inputs: { value: "[sanitized prompt]" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/openapi/getJsonApiFormat");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ workflowId: "123" });
      return json({ code: 0, data: { prompt: JSON.stringify(source) } });
    });
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: "123", apiKey: "fixture-local-test-key",
    } } as unknown as ReaderRequest, { fetcher } as unknown as ReaderOptions);
    expect(fetcher).toHaveBeenCalled();
    expect(result.workflow).toEqual(source);
    expect(result.parameterBindings?.every(binding => typeof binding.key === "string" && binding.key.length > 0)).toBe(true);
  });

  it("rejects competing source/remote paths before any transport or fallback runs", async () => {
    const fetcher = vi.fn(async () => { throw new Error("transport must not run"); });
    await expect(readAIFisherWorkflow({ environment: "runninghub-webapp", source: publicApp, remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: "fixture-local-test-key",
    } } as unknown as ReaderRequest, { fetcher } as unknown as ReaderOptions)).rejects.toMatchObject({ code: "AIFISHER_READER_SOURCE_CONFLICT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not return account credentials or curl authentication examples from the original remote metadata", async () => {
    const fixtureKey = "fixture-account-key-for-redaction";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/webapp/apiCallDemo") return new Response("", { status: 404 });
      return json({ code: 0, data: { ...publicApp, apiKey: fixtureKey, curl: "Bearer " + fixtureKey } });
    });
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: fixtureKey,
    } } as unknown as ReaderRequest, { fetcher } as unknown as ReaderOptions);
    expect(JSON.stringify(result)).not.toContain(fixtureKey);
    expect(result.runninghubSource?.rawInfo).not.toHaveProperty("curl");
    expect(result.runninghubSource?.rawInfo).not.toHaveProperty("apiKey");
  });

  it("keeps the original WebApp projection, field keys, optional media and four source controls", async () => {
    const before = structuredClone(publicApp);
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: appId, source: publicApp });
    const projection = createRunningHubWebAppProjection(appId, publicApp);
    expect(result.projection?.snapshot.fields.map(({ minimum, maximum, step, ...field }) => field)).toEqual(
      projection.snapshot.fields.map(({ minimum, maximum, step, ...field }) => field));
    expect(result.workflow).toEqual(projection.executionPlan);
    expect(result.parameterBindings).toHaveLength(7);
    expect(result.parameterBindings?.map(binding => binding.key)).toEqual([
      "field_166_strength_model", "field_188_image", "field_199_image", "field_227_value", "field_228_aspect_ratio", "field_228_megapixels", "field_238_value",
    ]);
    const analysis = analyzeRunningHubUpstream(adapterReader(result));
    expect(analysis.prompts).toEqual([expect.objectContaining({ nodeId: "238", field: "value" })]);
    expect(analysis.inputs.map(input => [input.nodeId, input.required])).toEqual([["188", false], ["199", false]]);
    const workflow = buildRunningHubUpstream(adapterReader(result), {
      id: "single-path-app", workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicApp.appName,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    expect(workflow.parameters.map(parameter => [parameter.key, parameter.label, parameter.type, parameter.default])).toEqual([
      ["field_166_strength_model", "电影感lora强度", "number", 0.85],
      ["field_227_value", "value", "number", 10],
      ["field_228_aspect_ratio", "aspect_ratio", "select", "16:9 (Widescreen)"],
      ["field_228_megapixels", "megapixels", "number", 1],
    ]);
    expect(workflow.parameters.find(parameter => parameter.label === "megapixels")).toMatchObject({ min: 0.1, max: 16, step: 0.1 });
    expect(workflow.parameters.find(parameter => parameter.label === "电影感lora强度")).toMatchObject({ min: -100, max: 100, step: 0.01 });
    const ratio = workflow.parameters[2];
    expect(ratio.options?.map(id => ratio.optionValues?.[id])).toEqual(ratios);
    const surface = generationParameterSurface(workflow);
    expect([...surface.basic, ...surface.advanced, ...surface.other].map(parameter => parameter.key)).toEqual(workflow.parameters.map(parameter => parameter.key));
    expect(workflow.template).toEqual(projection.executionPlan);
    expect(publicApp).toEqual(before);
  });

  it("uses the source text-control fallback for native workflows and retains every ordinary parameter", async () => {
    const source = {
      "1": { class_type: "PrimitiveString", inputs: { value: "[sanitized prompt]" } },
      "2": { class_type: "Generator", inputs: { steps: 8, seed: 16, cfg: 4.5, internal_switch: false, internal_gain: 0.25, string_mode: "default", prompt: ["1", 0] } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source });
    const analysis = analyzeRunningHubUpstream(adapterReader(result));
    expect(analysis.prompts[0]).toMatchObject({ nodeId: "1", field: "value" });
    expect(analysis.prompts).toHaveLength(2);
    const { workflow } = prepareRunningHubWorkflow(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "native source controls", reader: adapterReader(result) });
    const ordinarySource = result.parameterBindings!.filter(binding => binding.target.nodeId === "2");
    expect(ordinarySource).toHaveLength(6);
    expect(new Set(workflow.parameters.map(parameter => parameter.key))).toEqual(new Set(ordinarySource.map(binding => binding.key)));
    expect(workflow.mapping.find(binding => binding.semantic === "prompt")).toMatchObject({ nodeId: "1", field: "value" });
    expect(workflow.template).toEqual(result.workflow);
  });

  it("loads the complete unchanged deployment module and never extracts function source text", async () => {
    const module = await import("../vendor/aifisher/server/workflowRuntime/workflowDeploymentService.js");
    expect(typeof module.WorkflowDeploymentService).toBe("function");
    expect(typeof module.createPortableWorkflowProjection).toBe("function");
    const readerSource = (await Promise.all(["scripts/aifisher-workflow-reader.ts", "scripts/aifisher-runninghub-import.ts"]
      .map(file => readFile(path.resolve(file), "utf8")))).join("\n");
    expect(/portableProjectionSource|loadPortableProjection|data:text\/javascript|source\.slice\(/.test(readerSource)).toBe(false);
    expect(readerSource.includes("workflowDeploymentService.js")).toBe(true);
  });

  it("executes the complete original library, deployment, binding-set and canvas blueprint services", async () => {
    const [{ RunningHubWebAppLibraryService }, { WorkflowDeploymentService }, { WorkflowCanvasNodeService }] = await Promise.all([
      import("../vendor/aifisher/server/workflowRuntime/runningHubWebAppLibraryService.js"),
      import("../vendor/aifisher/server/workflowRuntime/workflowDeploymentService.js"),
      import("../vendor/aifisher/server/workflowRuntime/workflowCanvasNodeService.js"),
    ]);
    const library = vi.spyOn(RunningHubWebAppLibraryService.prototype, "createApp");
    const deployment = vi.spyOn(WorkflowDeploymentService.prototype, "createDeployment");
    const bindings = vi.spyOn(WorkflowDeploymentService.prototype, "createBindingSet");
    const blueprint = vi.spyOn(WorkflowCanvasNodeService.prototype, "createBlueprint");
    try {
      const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: appId, source: publicApp });
      expect(library).toHaveBeenCalledTimes(1);
      expect(deployment).toHaveBeenCalledTimes(1);
      expect(bindings).toHaveBeenCalledTimes(1);
      expect(blueprint).toHaveBeenCalledTimes(1);
      expect(result.canvasBlueprint).toBeDefined();
      const originalBlueprint = await blueprint.mock.results[0].value;
      expect(result.canvasBlueprint?.parameterSchema).toEqual(originalBlueprint.parameterSchema);
      expect(result.canvasBlueprint?.parameterSchema).toHaveLength(5);
      expect(result.canvasBlueprint?.parameterSchema.some((parameter: { control: { kind: string } }) => parameter.control.kind === "asset")).toBe(false);
    } finally {
      library.mockRestore(); deployment.mockRestore(); bindings.mockRestore(); blueprint.mockRestore();
    }
  });

  it("keeps retired read parsers and analyzers out of the active RunningHub editor and converter", async () => {
    for (const file of ["src/runninghub/RunningHubWorkflowDialog.tsx", "src/runninghub/workflows.ts"]) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(/\b(?:parseRunningHubAiApp|analyzeWorkflowImport|buildWorkflowImport|convertLibraryWorkflow)\b/.test(source), file).toBe(false);
    }
    const client = await readFile(path.resolve("src/runninghub/client.ts"), "utf8");
    const parsedClient = ts.createSourceFile("client.ts", client, ts.ScriptTarget.Latest, true);
    const methods = new Map<string, string>();
    function collectMethods(node: ts.Node) {
      if (ts.isMethodDeclaration(node) && node.body && node.name) methods.set(node.name.getText(parsedClient), node.body.getText(parsedClient));
      ts.forEachChild(node, collectMethods);
    }
    collectMethods(parsedClient);
    for (const name of ["getWorkflow", "getPublicWorkflowExport"]) {
      const body = methods.get(name)!;
      expect(body, name).toBeDefined();
      expect(body, name).toContain("this.readWorkflowDefinition(");
      expect(/this\.(?:post|request)\(|apiCallDemo|getJsonApiFormat|parseRunningHub/.test(body), name).toBe(false);
    }
    for (const [name, environment] of [["readWorkflowDefinition", "runninghub-workflow"], ["getAiApp", "runninghub-webapp"]]) {
      const body = methods.get(name)!;
      expect(body, name).toBeDefined();
      expect(body.includes(`readAifisherWorkflow({ environment: "${environment}", remote:`), name).toBe(true);
      expect(/this\.(?:post|request)\(|apiCallDemo|getJsonApiFormat|parseRunningHub/.test(body), name).toBe(false);
    }
    const dialog = await readFile(path.resolve("src/runninghub/RunningHubWorkflowDialog.tsx"), "utf8");
    const parsedDialog = ts.createSourceFile("dialog.tsx", dialog, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let remoteReadBody = "";
    function collectRemoteRead(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "readPlatformWorkflow") remoteReadBody = node.body!.getText(parsedDialog);
      ts.forEachChild(node, collectRemoteRead);
    }
    collectRemoteRead(parsedDialog);
    expect(remoteReadBody.length).toBeGreaterThan(0);
    expect(remoteReadBody.includes("upstream = app.reader")).toBe(true);
    expect(remoteReadBody.includes("readRunningHubAiAppReference(client")).toBe(true);
    expect(/\.getWorkflow\(|aifisherReadResultFor|"runninghub-workflow"/.test(dialog)).toBe(false);
    expect(/\breadAifisherWorkflow\(|runningHubAppGraph|parseRunningHubAiApp|apiCallDemo|getJsonApiFormat/.test(remoteReadBody)).toBe(false);
  });

  it("rejects missing upstream read results instead of falling back to local graph or schema inference", () => {
    const source = { "1": { class_type: "SaveImage", inputs: {} } };
    expect(() => prepareRunningHubWorkflow(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "requires original read" })).toThrow(/AIFISHER/);
    expect(() => runningHubAppGraph({ apiVersion: "v1", nodeInfoList: [] })).toThrow(/AIFISHER/);
    expect(() => analyzeRunningHubImport(source)).toThrow(/AIFISHER/);
  });

  it("retains all vendored files including the complete deployment and library modules byte-for-byte", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("vendor/aifisher/SOURCE.json"), "utf8"));
    expect(manifest.files.some((entry: { path: string }) => entry.path === "server/workflowRuntime/runningHubWebAppLibraryService.js")).toBe(true);
    for (const entry of manifest.files) {
      const bytes = await readFile(path.resolve("vendor/aifisher", entry.path));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
    }
    const deployment = await readFile(path.resolve("vendor/aifisher/server/workflowRuntime/workflowDeploymentService.js"), "utf8");
    expect(deployment).toContain("export class WorkflowDeploymentService");
    expect(deployment).toContain("async createDeployment(");
    expect(deployment).toContain("async createBindingSet(");
  });
});
