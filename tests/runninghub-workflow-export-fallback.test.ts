import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";

const workflowId = "2120361974323306498";
const remote = { baseUrl: "https://www.runninghub.cn", remoteId: workflowId, apiKey: "fixture-account-auth" };
const roots: string[] = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const editor = {
  version: 0.4,
  nodes: [
    { id: 1, type: "SeededImage", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [5, 7] }], widgets_values: [7, "randomize", 4, "fixture prompt"] },
    { id: 2, type: "Reroute", inputs: [{ name: "", type: "*", link: 5 }], outputs: [{ name: "", type: "*", links: [6] }], widgets_values: [] },
    { id: 3, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 6 }], outputs: [], widgets_values: ["Fixture"] },
    { id: 4, type: "Note", inputs: [], outputs: [], widgets_values: ["fixture note"] },
    { id: 5, type: "UpscaleImage", inputs: [{ name: "image", type: "IMAGE", link: 7 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [8] }], widgets_values: [2] },
    { id: 6, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 8 }], outputs: [], widgets_values: ["FixtureHD"] },
  ],
  links: [[5, 1, 0, 2, 0, "IMAGE"], [6, 2, 0, 3, 0, "IMAGE"], [7, 1, 0, 5, 0, "IMAGE"], [8, 5, 0, 6, 0, "IMAGE"]],
};
const definitions = {
  SeededImage: {
    input: { required: { seed: ["INT", { control_after_generate: true }], prompt: ["STRING", { multiline: true }], steps: ["INT", {}] } },
    input_order: { required: ["seed", "steps", "prompt"] }, output: ["IMAGE"],
  },
  SaveImage: {
    input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } },
    input_order: { required: ["images", "filename_prefix"] }, output: [], output_node: true,
  },
  UpscaleImage: {
    input: { required: { image: ["IMAGE", {}], scale: ["FLOAT", {}] } },
    input_order: { required: ["image", "scale"] }, output: ["IMAGE"],
  },
};
async function isolatedRoot() {
  const root = path.resolve(".cache", "runninghub-export-test-" + randomUUID());
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(".cache"), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Test directory escaped its cache");
    await rm(root, { recursive: true, force: true });
  }
});

describe("RunningHub existing workflow source fallback", () => {
  it("reads the official editor export when the API snapshot is absent, then uses the original AIFISHER services", async () => {
    const calls: string[] = [];
    const original = structuredClone(editor);
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      expect(url.origin).toBe(remote.baseUrl);
      expect(init?.redirect).toBe("manual");
      if (url.pathname === "/api/openapi/getJsonApiFormat") {
        expect(JSON.parse(String(init?.body)).apiKey).toBe(remote.apiKey);
        return response({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(String(init?.body)).not.toContain(remote.apiKey);
      if (url.pathname === "/api/workflow/export") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("accept")).toBe("*/*");
        expect(JSON.parse(String(init?.body))).toEqual({ workflowId });
        return response(editor);
      }
      expect(url.pathname).toMatch(/^\/object_info\//);
      expect(init?.method).toBe("GET");
      const classType = decodeURIComponent(url.pathname.slice("/object_info/".length));
      const definition = definitions[classType as keyof typeof definitions];
      return response({ nodes_info: definition ? { [classType]: definition } : { msg: "Node definition not found" } });
    };
    const projectRoot = await isolatedRoot();
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot, fetcher });
    expect(calls.slice(0, 2)).toEqual(["/api/openapi/getJsonApiFormat", "/api/workflow/export"]);
    expect(calls.slice(2).sort()).toEqual(["/object_info/Note", "/object_info/Reroute", "/object_info/SaveImage", "/object_info/SeededImage", "/object_info/UpscaleImage"]);
    expect(result.workflow?.["1"].inputs).toEqual({ seed: 7, steps: 4, prompt: "fixture prompt" });
    expect(result.workflow?.["3"].inputs).toEqual({ images: ["1", 0], filename_prefix: "Fixture" });
    expect(result.workflow?.["5"].inputs).toEqual({ image: ["1", 0], scale: 2 });
    expect(result.workflow?.["6"].inputs).toEqual({ images: ["5", 0], filename_prefix: "FixtureHD" });
    expect(Object.keys(result.workflow!)).toEqual(["1", "3", "5", "6"]);
    expect(result.parameterBindings?.some(binding => binding.target?.fieldName === "prompt" || binding.fieldName === "prompt")).toBe(true);
    expect(result.canvasBlueprint).toBeDefined();
    expect(result.runninghubSource?.workflowReadSource).toBe("official-editor-export");
    expect(editor).toEqual(original);
    expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
  });

  it("accepts an API-format public export without downloading node definitions", async () => {
    const graph = { "1": { class_type: "Generator", inputs: { prompt: "fixture prompt", api_key: "fixture-provider-secret" } } };
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      calls.push(pathname);
      if (pathname === "/api/openapi/getJsonApiFormat") return response({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
      expect(pathname).toBe("/api/workflow/export");
      return response(graph);
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot: await isolatedRoot(), fetcher });
    expect(calls).toEqual(["/api/openapi/getJsonApiFormat", "/api/workflow/export"]);
    expect(result.workflow?.["1"].inputs).toEqual({ prompt: "fixture prompt", api_key: "" });
    expect(JSON.stringify(result)).not.toContain("fixture-provider-secret");
    expect(result.runninghubSource?.workflowReadSource).toBe("official-api-export");
  });

  it.each(["www.runninghub.cn", "www.runninghub.ai"])("uses one canonical snapshot of every API node from %s", async hostname => {
    const generator = "900719925474099311";
    const graph = {
      [generator]: { class_type: "FixtureGenerator", inputs: { prompt: "demo", negative: "", seed: 874731702354943, steps: 18,
        config: { flags: [true, false], gain: 1.25 }, option: false } },
      "2": { class_type: "SaveImage", inputs: { images: [generator, 2], filename_prefix: "retained-output" } },
      "3": { class_type: "FixtureDisconnected", inputs: { value: 0 } },
    };
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe(hostname);
      expect(url.pathname).toBe("/api/openapi/getJsonApiFormat");
      expect(JSON.parse(String(init?.body))).toMatchObject({ workflowId, apiKey: remote.apiKey });
      return response({ code: 0, data: { prompt: JSON.stringify({ ...graph, "4": { inputs: {} } }) } });
    });
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: { ...remote, baseUrl: "https://" + hostname } },
      { projectRoot: await isolatedRoot(), fetcher: request });
    expect(request).toHaveBeenCalledOnce();
    expect(result.workflow).toEqual(graph);
    expect(result.runninghubSource?.workflowReadSource).toBe("official-api-format");
    expect(result.bindingCandidates.map(field => [field.nodeId, field.fieldName])).toEqual(expect.arrayContaining([
      [generator, "prompt"], [generator, "seed"], [generator, "config"], ["2", "filename_prefix"], ["3", "value"],
    ]));
    expect(result.outputEvidence.candidateNodes).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "2" })]));
  });

  it.each([
    [{ code: 401, msg: "unauthorized" }, 401],
    [{ code: 500, msg: "upstream unavailable" }, 503],
    [{ code: 0, data: {} }, 200],
  ])("preserves other API errors without substituting an export", async (body, status) => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(new URL(String(input)).pathname);
      return response(body, status);
    };
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot: await isolatedRoot(), fetcher })).rejects.toThrow();
    expect(calls).toEqual(["/api/openapi/getJsonApiFormat"]);
  });

  it("retains cancellation and releases temporary stores during the export fallback", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      calls.push(pathname);
      if (pathname === "/api/openapi/getJsonApiFormat") return response({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
      controller.abort(new Error("Fixture cancellation"));
      init?.signal?.throwIfAborted();
      return response(editor);
    };
    const projectRoot = await isolatedRoot();
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot, fetcher, signal: controller.signal })).rejects.toThrow("Fixture cancellation");
    expect(calls).toEqual(["/api/openapi/getJsonApiFormat", "/api/workflow/export"]);
    expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
  });

  it.each(["export", "node definitions"] as const)("bounds a keyed fallback stalled on %s", async phase => {
    const projectRoot = await isolatedRoot();
    const caller = new AbortController(), deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let reachedStall!: (signal: AbortSignal) => void;
    const stalled = new Promise<AbortSignal>(resolve => { reachedStall = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/openapi/getJsonApiFormat") return response({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
      if (phase === "node definitions" && pathname === "/api/workflow/export") return response(editor);
      const signal = init!.signal!;
      signal.throwIfAborted();
      return new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        reachedStall(signal);
      });
    };
    const outcome = readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot, fetcher, signal: caller.signal })
      .catch(error => error);
    try {
      const signal = await stalled;
      expect(timeout).toHaveBeenCalledWith(30_000);
      deadline.abort(new DOMException("Fixture export timeout", "TimeoutError"));
      expect(signal.aborted).toBe(true);
      expect(await outcome).toMatchObject({ status: 504, code: "RUNNINGHUB_WORKFLOW_EXPORT_TIMEOUT" });
      expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
    } finally {
      caller.abort();
      await outcome;
      timeout.mockRestore();
    }
  });

  it("does not discard unidentified widget values to manufacture an executable workflow", async () => {
    const invalid = structuredClone(editor);
    invalid.nodes[0].widgets_values.push("unidentified-extra");
    const fetcher: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/openapi/getJsonApiFormat") return response({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
      if (pathname === "/api/workflow/export") return response(invalid);
      const classType = decodeURIComponent(pathname.slice("/object_info/".length));
      const definition = definitions[classType as keyof typeof definitions];
      return response(definition ? { [classType]: definition } : { msg: "Node definition not found" });
    };
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", remote }, { projectRoot: await isolatedRoot(), fetcher }))
      .rejects.toMatchObject({ code: "RUNNINGHUB_WORKFLOW_EDITOR_CONVERSION_REQUIRED", message: expect.stringContaining("无法识别的额外控件") });
  });
});

describe("public RunningHub workflow imports without an API key", () => {
  const publicRemote = { baseUrl: remote.baseUrl, remoteId: workflowId, publicExport: true } as const;
  const publicCard = { id: workflowId, workflowState: 1, publishAccess: { granted: true, encrypted: false, needPassword: false } };

  it("checks public identity and exports a sanitized graph without making an API-key request", async () => {
    const calls: string[] = [];
    const graph = { "1": { class_type: "Generator", inputs: { prompt: "fixture prompt", api_key: "fixture-source-secret" } } };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      expect(url.origin).toBe(remote.baseUrl);
      expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ workflowId });
      if (url.pathname === "/api/workflow/getDetail") return response({ code: 0, data: publicCard });
      expect(url.pathname).toBe("/api/workflow/export");
      return response(graph);
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: publicRemote }, { projectRoot: await isolatedRoot(), fetcher });
    expect(calls).toEqual(["/api/workflow/getDetail", "/api/workflow/export"]);
    expect(result.workflow?.["1"].inputs).toEqual({ prompt: "fixture prompt", api_key: "" });
    expect(JSON.stringify(result)).not.toContain("fixture-source-secret");
    expect(result.runninghubSource?.workflowReadSource).toBe("official-api-export");
  });

  it("retries a public export once after a transient connection failure", async () => {
    const calls: string[] = [];
    const graph = { "1": { class_type: "Generator", inputs: { prompt: "fixture prompt" } } };
    const fetcher: typeof fetch = async input => {
      const pathname = new URL(String(input)).pathname;
      calls.push(pathname);
      if (pathname === "/api/workflow/getDetail") return response({ code: 0, data: publicCard });
      expect(pathname).toBe("/api/workflow/export");
      if (calls.length === 2) throw new Error("Fixture transient connection failure");
      return response(graph);
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: publicRemote }, { projectRoot: await isolatedRoot(), fetcher });
    expect(calls).toEqual(["/api/workflow/getDetail", "/api/workflow/export", "/api/workflow/export"]);
    expect(result.workflow).toEqual(graph);
  });

  it("converts a public graph when catalog entries for frontend-only nodes are unavailable", async () => {
    const baseUrl = "https://www.runninghub.ai";
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe(baseUrl);
      if (url.pathname === "/api/workflow/getDetail") return response({ code: 0, data: publicCard });
      if (url.pathname === "/api/workflow/export") return response(editor);
      const type = decodeURIComponent(url.pathname.slice("/object_info/".length));
      if (type === "Note" || type === "Reroute") return response({ code: 401 }, 401);
      return response({ nodes_info: { [type]: definitions[type as keyof typeof definitions] } });
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: { ...publicRemote, baseUrl } },
      { projectRoot: await isolatedRoot(), fetcher });
    expect(result.workflow).toEqual({
      "1": { class_type: "SeededImage", inputs: { seed: 7, steps: 4, prompt: "fixture prompt" }, _meta: { title: "SeededImage" } },
      "3": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "Fixture" }, _meta: { title: "SaveImage" } },
      "5": { class_type: "UpscaleImage", inputs: { image: ["1", 0], scale: 2 }, _meta: { title: "UpscaleImage" } },
      "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "FixtureHD" }, _meta: { title: "SaveImage" } },
    });
    expect(result.runninghubSource?.workflowReadSource).toBe("official-editor-export");
  });

  it.each([
    { ...publicCard, id: "2120361974323306499" },
    { ...publicCard, workflowState: 0 },
    { ...publicCard, publishAccess: { ...publicCard.publishAccess, granted: false } },
    { ...publicCard, publishAccess: { ...publicCard.publishAccess, encrypted: true } },
    { ...publicCard, publishAccess: { ...publicCard.publishAccess, needPassword: true } },
  ])("declines export after a mismatched, private, or protected public card", async card => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async input => {
      calls.push(new URL(String(input)).pathname);
      return response({ code: 0, data: card });
    };
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", remote: publicRemote }, { projectRoot: await isolatedRoot(), fetcher }))
      .rejects.toMatchObject({ code: "RUNNINGHUB_WORKFLOW_PUBLIC_ACCESS_REQUIRED", status: 403 });
    expect(calls).toEqual(["/api/workflow/getDetail"]);
  });

  it("keeps the original public editor workflow when the node widgets cannot be converted", async () => {
    const source = structuredClone(editor);
    source.nodes[0].widgets_values.push("unidentified-extra");
    const fetcher: typeof fetch = async input => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/workflow/getDetail") return response({ code: 0, data: publicCard });
      if (pathname === "/api/workflow/export") return response(source);
      expect(pathname).toMatch(/^\/object_info\//);
      const classType = decodeURIComponent(pathname.slice("/object_info/".length));
      const definition = definitions[classType as keyof typeof definitions];
      return response(definition ? { [classType]: definition } : { msg: "Node definition not found" });
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: publicRemote }, { projectRoot: await isolatedRoot(), fetcher });
    expect(result).toMatchObject({ format: "comfy-ui-0.4", workflow: null, editorWorkflow: source,
      runninghubSource: { workflowReadSource: "official-editor-export" } });
  });

  it("keeps the authorized source when its node definitions time out", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    try {
      const fetcher: typeof fetch = async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/workflow/getDetail") return response({ code: 0, data: publicCard });
        if (pathname === "/api/workflow/export") return response(editor);
        expect(pathname).toMatch(/^\/object_info\//);
        deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
        init?.signal?.throwIfAborted();
        return response({});
      };
      const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: publicRemote }, { projectRoot: await isolatedRoot(), fetcher });
      expect(result).toMatchObject({ workflow: null, editorWorkflow: editor });
    } finally { timeout.mockRestore(); }
  });
});
