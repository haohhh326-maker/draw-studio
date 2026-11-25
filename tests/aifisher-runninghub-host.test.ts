import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";

const nodeTransport = vi.hoisted(() => vi.fn());
vi.mock("node-fetch", async () => {
  const original = await vi.importActual<typeof import("node-fetch")>("node-fetch");
  return { ...original, default: nodeTransport };
});

const appId = "123456789";
const roots: string[] = [];
afterEach(async () => {
  nodeTransport.mockReset();
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(".cache"), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Test directory escaped its cache");
    await rm(root, { recursive: true, force: true });
  }
});
async function isolatedRoot() {
  const root = path.resolve(".cache", "aifisher-host-test-" + randomUUID());
  roots.push(root); await mkdir(root, { recursive: true }); return root;
}

describe("AIFISHER host transport and credential boundaries", () => {
  it.each(["headers", "body"] as const)("enforces the keyed read deadline while waiting for %s and removes its temporary files", async phase => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const caller = new AbortController();
    const cancelBody = vi.fn();
    let started!: (value: AbortSignal | null | undefined) => void;
    const transportStarted = new Promise<AbortSignal | null | undefined>(resolve => { started = resolve; });
    const projectRoot = await isolatedRoot();
    const fetcher: typeof fetch = async (_url, init) => {
      started(init?.signal);
      if (phase === "headers") return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return new Response(new ReadableStream({ cancel: cancelBody }), { headers: { "Content-Type": "application/json" } });
    };
    const request = { environment: "runninghub-workflow", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: "fixture-account-auth",
    } } as const;
    const outcome = readAIFisherWorkflow(request, { projectRoot, fetcher, signal: caller.signal }).catch(error => error);
    try {
      const transportSignal = await transportStarted;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(transportSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ status: 504, code: "RUNNINGHUB_REQUEST_TIMEOUT" });
      if (phase === "body") expect(cancelBody).toHaveBeenCalledOnce();
      expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
      const graph = { result: { class_type: "SaveImage", inputs: { filename_prefix: "fixture-after-timeout" } } };
      const recovered = vi.fn(async () => Response.json({ code: 0, data: { prompt: JSON.stringify(graph) } }));
      expect((await readAIFisherWorkflow(request, { projectRoot, fetcher: recovered })).workflow).toEqual(graph);
      expect(recovered).toHaveBeenCalledOnce();
      expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
    } finally {
      caller.abort();
      vi.useRealTimers();
      if (phase === "headers") await outcome;
    }
  });

  it("bridges the real node-fetch stream into the deadline-bound upstream WHATWG reader", async () => {
    const { Response: NodeResponse } = await vi.importActual<typeof import("node-fetch")>("node-fetch");
    const incoming = { appName: "Fixture", nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "[sanitized prompt]" }] };
    nodeTransport.mockImplementation(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe("/api/webapp/apiCallDemo");
      expect(init).not.toHaveProperty("timeout");
      expect(init).not.toHaveProperty("timeoutMs");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new NodeResponse(JSON.stringify({ code: 0, data: incoming }), { headers: { "content-type": "application/json" } });
    });
    const projectRoot = await isolatedRoot();
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: "fixture-account-auth",
    } }, { projectRoot });
    expect(nodeTransport).toHaveBeenCalled();
    expect(result.parameterBindings?.[0].key).toBe("field_1_prompt");
    expect(result.workflow?.["1"].inputs.prompt).toBe("[sanitized prompt]");
    expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
  });

  it("removes explicit provider secrets before the original projection, stores and public DTO", async () => {
    const fixtureSecret = "fixture-provider-key-not-a-real-secret";
    const source = { appName: "Fixture", curl: "hidden curl", apiKey: "fixture-account-auth", nodeInfoList: [
      { nodeId: "1", fieldName: "private_field", label: "Provider", fieldType: "STRING", secret: true, fieldValue: fixtureSecret,
        defaultValue: fixtureSecret, fieldData: '["STRING",{"default":"' + fixtureSecret + '"}]', options: [fixtureSecret] },
      { nodeId: "2", fieldName: "prompt", fieldType: "STRING", fieldValue: "[sanitized prompt]" },
    ] };
    const original = structuredClone(source), projectRoot = await isolatedRoot();
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", source, remoteId: appId }, { projectRoot });
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
    expect(result.runninghubSource?.rawInfo).not.toHaveProperty("curl");
    expect(result.runninghubSource?.rawInfo).not.toHaveProperty("apiKey");
    expect(result.runninghubSource?.rawInfo?.nodeInfoList[0]).toMatchObject({ secret: true, fieldValue: "", defaultValue: "" });
    expect(result.credentialTargets).toEqual([{ nodeId: "1", fieldName: "private_field", required: true, secret: true }]);
    expect(source).toEqual(original);
    expect(await readdir(path.join(projectRoot, ".cache"))).toEqual([]);
  });

  it("runs the unchanged AI public-page decoder when its public detail endpoint is unavailable", async () => {
    const flat = [{ data: 1 }, { id: 2, name: 3, inputNodes: 4 }, appId, "Fixture", [5],
      { nodeId: 6, fieldName: 7, fieldType: 8, fieldValue: 9 }, "1", "prompt", "STRING", "[sanitized prompt]"];
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (url.pathname === "/api/webapp/detail") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ code: 500, message: "Fixture unavailable" }), { status: 503 });
      }
      expect(url.pathname).toBe("/ai-detail/" + appId);
      expect(init?.method).toBe("GET");
      return new Response('<html><script id="__NUXT_DATA__" type="application/json">' + JSON.stringify(flat) + "</script></html>", { headers: { "content-type": "text/html" } });
    };
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.ai", remoteId: appId, apiKey: "fixture-account-auth",
    } }, { projectRoot: await isolatedRoot(), fetcher });
    expect(calls).toContain("/api/webapp/detail");
    expect(calls).toContain("/ai-detail/" + appId);
    expect(result.workflow?.["1"].inputs.prompt).toBe("[sanitized prompt]");
    expect(result.parameterBindings?.[0].key).toBe("field_1_prompt");
    expect(result.runninghubSource?.apiProtocol).toBe("legacy-webapp-v1");
  });

  it("retains a credential graph edge while clearing its proven PrimitiveString source", async () => {
    const source = { key: { class_type: "PrimitiveString", inputs: { value: "fixture-author-provider-key" } },
      generator: { class_type: "Generator", inputs: { api_key: ["key", 0], prompt: "[sanitized prompt]" } } };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }, { projectRoot: await isolatedRoot() });
    expect(result.workflow?.generator.inputs.api_key).toEqual(["key", 0]);
    expect(result.workflow?.key.inputs.value).toBe("");
    expect(result.credentialTargets).toEqual([{ nodeId: "key", fieldName: "value", required: true, secret: true }]);
    expect(JSON.stringify(result)).not.toContain("fixture-author-provider-key");
    expect(source.key.inputs.value).toBe("fixture-author-provider-key");
  });

  it("keeps unproven linked credential ports intact and does not reinterpret their upstream values", async () => {
    const source = { supplier: { class_type: "DynamicKeyProvider", inputs: { profile: "named-profile" } },
      generator: { class_type: "Generator", inputs: { api_key: ["supplier", 0], prompt: "[sanitized prompt]" } } };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }, { projectRoot: await isolatedRoot() });
    expect(result.workflow).toEqual(source);
    expect(result.credentialTargets).toEqual([]);
  });

  it("propagates explicit cancellation and cleans only the reader's temporary directory", async () => {
    const controller = new AbortController(), projectRoot = await isolatedRoot();
    await mkdir(path.join(projectRoot, ".cache", "unrelated"), { recursive: true });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort(new Error("Fixture cancellation"));
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(readAIFisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: "https://www.runninghub.cn", remoteId: appId, apiKey: "fixture-account-auth",
    } }, { projectRoot, fetcher, signal: controller.signal })).rejects.toThrow("Fixture cancellation");
    expect(await readdir(path.join(projectRoot, ".cache"))).toEqual(["unrelated"]);
  });
});
