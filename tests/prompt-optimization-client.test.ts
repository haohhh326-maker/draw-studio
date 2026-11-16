import { afterEach, expect, it, vi } from "vitest";
import { optimizationClient, resetOptimizationReadCaches } from "../src/prompt-optimization/client";
import { useStore } from "../src/stores/store";
import type { OptimizationContext, OptimizationSettings, OptimizationTarget } from "../src/prompt-optimization/types";

const endpoint = "/__canvas/prompt-optimization/settings";

function settings(overrides: Partial<OptimizationSettings> = {}): OptimizationSettings {
  return {
    provider: "comfyui",
    connectionSource: "canvas",
    baseUrl: "",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelId: "",
    visionModelId: "",
    mmproj: "",
    device: "cuda",
    readMedia: true,
    maxTokens: 4096,
    contextTokens: 16384,
    language: "zh",
    skillDirectory: "",
    capabilities: {},
    keyConfigured: false,
    ...overrides,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

const originalConnection = { ...useStore.getState().connection };
const originalComputeProvider = useStore.getState().computeProvider;
afterEach(() => { resetOptimizationReadCaches(); vi.unstubAllGlobals(); useStore.setState({ connection: { ...originalConnection }, computeProvider: originalComputeProvider }); });
it("fills the legacy context capacity without changing its output budget", async () => {
  const legacy: Partial<OptimizationSettings> = settings({ maxTokens: 8192 }); delete legacy.contextTokens;
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(legacy)));
  await expect(optimizationClient.settings()).resolves.toMatchObject({ maxTokens: 8192, contextTokens: 16384 });
});

it("migrates a legacy custom ComfyUI optimizer connection to the canvas connection", async () => {
  useStore.setState({ computeProvider: "comfyui" });
  const legacy = settings({
    connectionSource: "custom",
    baseUrl: "https://old-optimizer.example/api",
    authHeader: "X-Legacy-Key",
    authPrefix: "Token ",
  });
  const migrated = settings();
  const fetcher = vi.fn(async () => jsonResponse(fetcher.mock.calls.length === 1 ? legacy : migrated));
  vi.stubGlobal("fetch", fetcher);

  await expect(optimizationClient.settings()).resolves.toEqual(migrated);

  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("GET");
  expect(fetcher.mock.calls[1][0]).toBe(endpoint);
  const migration = JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string);
  expect(migration).toEqual({ connectionSource: "canvas", baseUrl: "" });
  expect(migration).not.toHaveProperty("apiKey");
  expect(migration).not.toHaveProperty("token");
  expect(migration).not.toHaveProperty("authHeader");
  expect(migration).not.toHaveProperty("authPrefix");
});

it("does not rewrite AutoDL optimizer settings while using DeepSeek for RunningHub", async () => {
  useStore.setState({ computeProvider: "runninghub" });
  const legacy = settings({ connectionSource: "custom", baseUrl: "https://autodl-optimizer.example/api" });
  const fetcher = vi.fn(async () => jsonResponse(legacy));
  vi.stubGlobal("fetch", fetcher);

  await expect(optimizationClient.settings()).resolves.toEqual(legacy);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("GET");
});

it("normalizes a former template directory to the Skill directory without posting legacy fields", async () => {
  const { skillDirectory: _removed, ...legacy } = settings();
  const fetcher = vi.fn(async () => jsonResponse({ ...legacy, templateDirectory: "E:/existing-prompt-directory" }));
  vi.stubGlobal("fetch", fetcher);

  const migrated = await optimizationClient.settings();
  expect(migrated.skillDirectory).toBe("E:/existing-prompt-directory");
  expect(migrated).not.toHaveProperty("templateDirectory");
  await optimizationClient.saveSettings(migrated);
  const body = JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string);
  expect(body.skillDirectory).toBe("E:/existing-prompt-directory");
  expect(body).not.toHaveProperty("templateDirectory");
});

it("does not write settings when ComfyUI already uses the canvas connection", async () => {
  const current = settings({ modelId: "Qwen3.8-27B.gguf" });
  const fetcher = vi.fn(async () => jsonResponse(current));
  vi.stubGlobal("fetch", fetcher);

  await expect(optimizationClient.settings()).resolves.toEqual(current);

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("GET");
});

it("keeps an OpenAI-compatible optimizer endpoint independent from the canvas connection", async () => {
  const openAi = settings({
    provider: "openai-compatible",
    connectionSource: "custom",
    baseUrl: "https://optimizer.example/v1",
    authHeader: "X-API-Key",
    authPrefix: "",
    modelId: "vision-model",
    keyConfigured: true,
  });
  const fetcher = vi.fn(async () => jsonResponse(openAi));
  vi.stubGlobal("fetch", fetcher);

  await expect(optimizationClient.settings()).resolves.toEqual(openAi);

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  expect((fetcher.mock.calls[0][1] as RequestInit).method).toBe("GET");
});

it("uses the current small-cloud credentials for model discovery and optimization without saving them in optimizer settings", async () => {
  useStore.setState({ computeProvider: "comfyui" });
  const connection = {
    ...originalConnection,
    baseUrl: "https://canvas.example/canvas/comfy",
    token: "session-only-token",
    authHeader: "X-Canvas-Token",
    authPrefix: "Token ",
  };
  useStore.setState({ connection });
  const fetcher = vi.fn(async (url: string) => jsonResponse(url.endsWith("/models")
    ? { models: [] }
    : { prompt: "优化后的提示词", modelId: "model.gguf", analyzedImages: 0, skill: { id: "generic", name: "通用", level: "generic" }, warnings: [] }));
  vi.stubGlobal("fetch", fetcher);
  const context: OptimizationContext = {
    target: { model: "model.gguf", family: "测试", workflowId: "workflow", workflowName: "工作流", mode: "text-to-image", kind: "image" },
    prompt: "原始提示词", negativePrompt: "", references: [], mentions: {},
  };

  await optimizationClient.models();
  await optimizationClient.optimize(context);

  const modelsBody = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
  const optimizeBody = JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string);
  expect(modelsBody).toEqual({ connection: { baseUrl: connection.baseUrl, token: connection.token, authHeader: connection.authHeader, authPrefix: connection.authPrefix } });
  expect(optimizeBody).toMatchObject({ context, textOnly: false, connection: modelsBody.connection });
});

it.each(["runninghub", "runninghub-workflow", "muse"] as const)("routes %s prompt optimization to DeepSeek Web without forwarding AutoDL credentials", async provider => {
  useStore.setState({ computeProvider: provider, connection: { ...originalConnection, token: "autodl-private-token" } });
  const fetcher = vi.fn(async () => jsonResponse({ prompt: "优化后的提示词", modelId: "DeepSeek Web", analyzedImages: 0, skill: { id: "generic", name: "通用", level: "generic" }, warnings: [] }));
  vi.stubGlobal("fetch", fetcher);
  const context: OptimizationContext = {
    target: { model: "test", family: "test", workflowId: "workflow", workflowName: "工作流", mode: "text-to-image", kind: "image" },
    prompt: "原始提示词", negativePrompt: "", references: [], mentions: {},
  };

  await optimizationClient.optimize(context);

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/__canvas/prompt-optimization/optimize");
  expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({ context, textOnly: true, engine: "deepseek-web" });
});

const target: OptimizationTarget = { model: "Qwen Image", family: "Qwen Image", workflowId: "qwen", workflowName: "文生图", mode: "text-to-image", kind: "image" };
it.each(["comfyui", "runninghub"] as const)("honors a scoped %s optimization route instead of the toolbar default", async computeProvider => {
  useStore.setState({ computeProvider: computeProvider === "comfyui" ? "muse" : "comfyui" });
  const fetcher = vi.fn(async () => jsonResponse({ prompt: "优化结果" })); vi.stubGlobal("fetch", fetcher);
  const context: OptimizationContext = { target, prompt: "原提示词", negativePrompt: "", references: [], mentions: {} };
  const connection = { ...originalConnection, baseUrl: "https://scoped-cloud.example", token: "scoped-token" };
  await optimizationClient.optimize(context, false, undefined, { computeProvider, connection });
  const body = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
  if (computeProvider === "comfyui") expect(body).toMatchObject({ context, textOnly: false, connection: { baseUrl: connection.baseUrl, token: connection.token } });
  else expect(body).toEqual({ context, textOnly: true, engine: "deepseek-web" });
});

it("migrates ComfyUI settings for the target card even when the default provider is Muse", async () => {
  useStore.setState({ computeProvider: "muse" });
  const legacy = settings({ connectionSource: "custom", baseUrl: "https://legacy.example" });
  const fetcher = vi.fn(async () => jsonResponse(fetcher.mock.calls.length === 1 ? legacy : settings())); vi.stubGlobal("fetch", fetcher);
  await expect(optimizationClient.settings(undefined, "comfyui")).resolves.toMatchObject({ connectionSource: "canvas" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

const skillStatus = { directory: "E:/skills", skills: [{ id: "qwen", name: "Qwen Image", description: "Image prompting rules" }], warnings: [], match: { id: "qwen", name: "Qwen Image", level: "family" } };
const modelInventory = { models: [{ id: "qwen.gguf", available: true, capability: "vision" }], mmprojModels: ["mmproj.gguf"] };

it("reuses settings, Skill matches and models when settings are reopened, without exposing a mutable cached object", async () => {
  const current = settings({ skillDirectory: "E:/skills" });
  const fetcher = vi.fn(async (url: string) => jsonResponse(url.endsWith("/settings") ? current : url.endsWith("/skills") ? skillStatus : modelInventory));
  vi.stubGlobal("fetch", fetcher);
  await optimizationClient.settings();
  const first = await optimizationClient.skills(target);
  first.skills.length = 0;
  const models = await optimizationClient.models();
  models.models.length = 0;

  await expect(optimizationClient.settings()).resolves.toEqual(current);
  await expect(optimizationClient.skills({ ...target })).resolves.toEqual(skillStatus);
  await expect(optimizationClient.models()).resolves.toEqual(modelInventory);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("scopes Skill matches to the workflow and directory, retaining them across unrelated settings saves", async () => {
  let current = settings({ skillDirectory: "E:/skills" });
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/settings")) {
      if (init.method === "POST") current = { ...current, ...JSON.parse(init.body as string) };
      return jsonResponse(current);
    }
    return jsonResponse(url.endsWith("/skills") ? { ...skillStatus, directory: current.skillDirectory } : modelInventory);
  });
  vi.stubGlobal("fetch", fetcher);
  await optimizationClient.settings();
  await optimizationClient.skills(target);
  await optimizationClient.models();
  await optimizationClient.skills({ ...target, workflowId: "other", mode: "image-to-image" });
  await optimizationClient.skills(target);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/skills"))).toHaveLength(2);

  await optimizationClient.saveSettings({ language: "en" });
  await optimizationClient.skills(target);
  await optimizationClient.models();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/skills"))).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/models"))).toHaveLength(1);
  await expect(optimizationClient.settings()).resolves.toMatchObject({ language: "en" });

  await optimizationClient.saveSettings({ skillDirectory: "E:/new-skills" });
  await expect(optimizationClient.skills(target)).resolves.toMatchObject({ directory: "E:/new-skills" });
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/skills"))).toHaveLength(3);
});

it("invalidates discovery on a changed cloud URL or credential, and supports explicit model and Skill refresh", async () => {
  const fetcher = vi.fn(async (url: string) => jsonResponse(url.endsWith("/skills") ? skillStatus : modelInventory));
  vi.stubGlobal("fetch", fetcher);
  await optimizationClient.models(); await optimizationClient.skills(target);
  await optimizationClient.models(); await optimizationClient.skills(target);
  expect(fetcher).toHaveBeenCalledTimes(2);
  useStore.setState({ connection: { ...useStore.getState().connection, baseUrl: "https://new-cloud.example", token: "new-session-token" } });
  await optimizationClient.models(); await optimizationClient.skills(target);
  expect(fetcher).toHaveBeenCalledTimes(4);
  useStore.setState({ connection: { ...useStore.getState().connection, token: "rotated-token" } });
  await optimizationClient.models(); await optimizationClient.skills(target);
  expect(fetcher).toHaveBeenCalledTimes(6);
  await optimizationClient.models(undefined, true);
  await optimizationClient.skills(target, true);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string)).toMatchObject({ refresh: true });
});

it("invalidates models after an optimizer endpoint or API credential save", async () => {
  let current = settings();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (!url.endsWith("/settings")) return jsonResponse(modelInventory);
    if (init.method === "POST") current = { ...current, ...JSON.parse(init.body as string) };
    return jsonResponse(current);
  });
  vi.stubGlobal("fetch", fetcher);
  await optimizationClient.settings(); await optimizationClient.models();
  await optimizationClient.saveSettings({ provider: "openai-compatible", baseUrl: "https://ai.example/v1", connectionSource: "custom", apiKey: "private-key" });
  await optimizationClient.models();
  await optimizationClient.saveSettings({ apiKey: "another-private-key" });
  await optimizationClient.models();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/models"))).toHaveLength(3);
});

it("does not cache a failed model discovery, missing Skill directory, or failed request", async () => {
  let modelReads = 0, skillReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/models")) return jsonResponse(++modelReads === 1 ? { models: [], warning: "HTTP 403" } : modelInventory);
    skillReads++;
    if (skillReads === 1) throw new Error("offline");
    return jsonResponse(skillReads === 2 ? { ...skillStatus, error: "directory missing" } : skillStatus);
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(optimizationClient.models()).resolves.toMatchObject({ warning: "HTTP 403" });
  await expect(optimizationClient.models()).resolves.toEqual(modelInventory);
  await expect(optimizationClient.skills(target)).rejects.toThrow("offline");
  await expect(optimizationClient.skills(target)).resolves.toMatchObject({ error: "directory missing" });
  await expect(optimizationClient.skills(target)).resolves.toEqual(skillStatus);
  await optimizationClient.models(); await optimizationClient.skills(target);
  expect(modelReads).toBe(2); expect(skillReads).toBe(3);
});

it("does not let an older settings read replace settings saved while the read was pending", async () => {
  let finishRead!: (value: Response) => void;
  const saved = settings({ skillDirectory: "E:/new", language: "en" });
  const fetcher = vi.fn((_: string, init: RequestInit) => init.method === "GET"
    ? new Promise<Response>(resolve => { finishRead = resolve; }) : Promise.resolve(jsonResponse(saved)));
  vi.stubGlobal("fetch", fetcher);
  const pending = optimizationClient.settings();
  await Promise.resolve();
  await optimizationClient.saveSettings({ language: "en" });
  finishRead(jsonResponse(settings({ skillDirectory: "E:/old" })));
  await expect(pending).resolves.toEqual(saved);
  await expect(optimizationClient.settings()).resolves.toEqual(saved);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
