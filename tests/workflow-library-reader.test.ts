import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { workflowLibraryPlugin } from "../scripts/workflow-library-plugin";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { withBuiltinBindings } from "../src/workflow/catalog";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder,{recursive:true,force:true}))); });
async function fixtureRoot() {
  const folder = await mkdtemp(path.join(os.tmpdir(),"canvas-library-"));
  temporary.push(folder); return folder;
}
const graph = () => ({
  "1": {class_type:"VHS_LoadVideoPath",inputs:{video:"source-machine.mp4"}},
  "3": {class_type:"DepthAnything",inputs:{images:["1",0],resolution:704,model:"depth.safetensors"}},
  "4": {class_type:"VHS_VideoCombine",inputs:{images:["3",0],filename_prefix:"example",save_output:false}},
});
const config = (id = "video.deep") => ({
  id,version:"1.0.0",nameLabel:{"zh-CN":"视频转深度"},primaryCategoryLabel:{"zh-CN":"视频转换"},nodeKind:"video",runnerType:"comfyui",
  inputs:[{id:"input1",name:"Video",description:"输入视频",dataType:"video",required:true,binding:{target:"comfyui",nodeId:"1",path:"inputs.video"}}],
  parameters:[{id:"resolution3",type:"integer",label:{"zh-CN":"分辨率"},defaultValue:704,min:64,max:4032,step:64,binding:{target:"comfyui",nodeId:"3",path:"inputs.resolution"}}],
  execution:{file:"execution.api.json"},
});
async function writeWorkflow(root: string, folder: string, cfg: unknown = config(), execution: unknown = graph()) {
  const target = path.join(root,folder); await mkdir(target,{recursive:true});
  await writeFile(path.join(target,"workflow.config.json"),JSON.stringify(cfg));
  await writeFile(path.join(target,"execution.api.json"),JSON.stringify(execution));
}

describe("dynamic reference input numbering", () => {
  const dynamicGraph = {
    loader: { class_type: "Image Load", inputs: { image: "reference.png" } },
    encode: { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["loader", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["encode", 0] } },
  };
  const dynamicConfig = (route: Record<string, unknown> = {}) => ({
    id: "image.references", nameLabel: "Reference edit", nodeKind: "image", runnerType: "comfyui", inputs: [], parameters: [],
    dynamicInput: {
      enabled: true, mode: "ordered-media-collection", binding: { target: "comfyui", targetNodeId: "encode" }, constraints: { minTotal: 0 },
      routes: { image: { maxItems: 16, prototypeNodeIds: ["loader"], pathBinding: { nodeId: "loader", path: "inputs.image" }, output: { nodeId: "loader", index: 0 }, targetInputPrefix: "images.image_", ...route } },
    },
    execution: { file: "execution.api.json" },
  });
  const convert = (route: Record<string, unknown> = {}) => convertLibraryWorkflow(dynamicConfig(route), dynamicGraph, undefined,
    { sourcePath: "test", folder: "test", configSha256: "", executionSha256: "", executionStatus: "plain" });

  it("preserves an explicit one-based start through library reading without rewriting the package", async () => {
    const root = await fixtureRoot(), cfg = dynamicConfig({ targetInputStartIndex: 1 });
    await writeWorkflow(root, "Qwen-Image21-Edit", cfg, dynamicGraph);
    const saved = await readFile(path.join(root, "Qwen-Image21-Edit", "workflow.config.json"), "utf8");
    const result = await readWorkflowLibrary(root);
    expect(result.issues).toEqual([]);
    expect(result.workflows[0].dynamicReferences?.routes.image).toMatchObject({ targetInputStartIndex: 1, targetInputPrefix: "images.image_", maxItems: 16 });
    expect(await readFile(path.join(root, "Qwen-Image21-Edit", "workflow.config.json"), "utf8")).toBe(saved);
  });
  it("keeps legacy omitted starts and explicit zero-based starts compatible", () => {
    expect(convert().dynamicReferences?.routes.image).not.toHaveProperty("targetInputStartIndex");
    expect(convert({ targetInputStartIndex: 0 }).dynamicReferences?.routes.image).toMatchObject({ targetInputStartIndex: 0 });
  });
  it.each([-1, 0.5, "1", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid start index %s", targetInputStartIndex => {
    expect(() => convert({ targetInputStartIndex })).toThrow("动态输入起始索引无效");
  });
  it("rejects ranges that exceed safe integer indexing", () => {
    expect(() => convert({ targetInputStartIndex: Number.MAX_SAFE_INTEGER, maxItems: 2 })).toThrow("动态输入起始索引无效");
    expect(() => convert({ targetInputStartIndex: 0, maxItems: Number.MAX_SAFE_INTEGER + 1 })).toThrow("动态加载器配置无效");
    expect(convert({ targetInputStartIndex: Number.MAX_SAFE_INTEGER - 1, maxItems: 2 }).dynamicReferences?.routes.image).toMatchObject({ targetInputStartIndex: Number.MAX_SAFE_INTEGER - 1 });
  });
});

describe("local workflow library reader", () => {
  it("preserves an API's declared generation model without carrying request authentication", async () => {
    const root = await fixtureRoot();
    await writeWorkflow(root, "arbitrary-name", { ...config("unrelated-id"), nodeKind: "image", runnerType: "api", primaryCategoryLabel: "API",
      prompt: { binding: { target: "api", path: "body.prompt" } },
      execution: { file: "execution.api.json", model: "gpt-image-2", auth: { token: "never-carry-to-optimizer" } },
    });
    const result = await readWorkflowLibrary(root);
    expect(result.workflows[0]).toMatchObject({ family: "API", generationModels: ["gpt-image-2"], library: { runnerType: "api" } });
    expect(result.workflows[0].original?.promptBinding).toEqual({ target: "api", path: "body.prompt" });
    expect(JSON.stringify(result.workflows[0])).not.toContain("never-carry-to-optimizer");
  });
  it("binds video input, resolution and VHS output without retaining source example paths", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"VideoDeep");
    const before = await readFile(path.join(root,"VideoDeep","execution.api.json"));
    const result = await readWorkflowLibrary(root);
    expect(result.scanned).toBe(1); expect(result.issues).toEqual([]); expect(result.loadedAt).toBeTypeOf("number");
    const workflow = result.workflows[0];
    expect(workflow.name).toBe("视频转深度"); expect(workflow.family).toBe("视频转换");
    expect(workflow.original?.executionStatus).toBe("plain");
    expect(workflow.mapping).toContainEqual({semantic:"slot:input1",nodeId:"1",field:"video",pathMode:"comfy-input"});
    expect(workflow.template?.["1"].inputs.video).toBe("");
    expect(workflow.output).toMatchObject({nodeId:"4",field:"gifs",kind:"video"});
    const node = {id:"n",position:{x:0,y:0},data:{title:"Test",kind:"video" as const,generation:{workflowId:workflow.id,prompt:"",negativePrompt:"",params:{resolution3:1024},taskId:null}}};
    const built = buildWorkflow(workflow,node,[{semantic:"slot:input1",edgeId:"edge",asset:{id:"asset",name:"clip.mp4",kind:"video",mime:"video/mp4",size:1,createdAt:1}}],{asset:"infinite-canvas/task/clip.mp4"},"infinite-canvas/task/result");
    expect(built.workflow["1"].inputs.video).toBe("input/infinite-canvas/task/clip.mp4");
    expect(built.workflow["3"].inputs.resolution).toBe(1024);
    expect(built.workflow["4"].inputs).toMatchObject({save_output:true,filename_prefix:"infinite-canvas/task/result"});
    expect(await readFile(path.join(root,"VideoDeep","execution.api.json"))).toEqual(before);
  });
  it("registers unsupported runners, malformed bindings and ambiguous outputs with execution issues", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"valid");
    await writeWorkflow(root,"api-only",{...config("api"),runnerType:"api"});
    const bad = config("bad"); bad.parameters[0].binding.nodeId = "missing"; await writeWorkflow(root,"bad-binding",bad);
    await writeWorkflow(root,"two-output",config("two"),{...graph(),"5":{class_type:"SaveImage",inputs:{images:["3",0],filename_prefix:"other"}}});
    const result = await readWorkflowLibrary(root);
    expect(result.scanned).toBe(4); expect(result.workflows).toHaveLength(4);
    expect(result.workflows.filter(workflow => workflow.template).map(workflow => workflow.original?.id)).toEqual(["video.deep"]);
    expect(result.issues.map(issue => issue.folder).sort()).toEqual(["api-only","bad-binding","two-output"]);
    expect(result.issues.find(issue => issue.folder === "two-output")?.message).toContain("多个");
    expect(result.issues.every(issue => issue.message.startsWith("已加入目录，执行"))).toBe(true);
    const api = result.workflows.find(workflow => workflow.original?.id === "api");
    expect(api?.library).toMatchObject({runnerType:"api",executionIssue:expect.stringContaining("runnerType=api")});
    expect(api?.template).toBeUndefined();
  });
  it("rejects traversal and directory links escaping the selected root", async () => {
    const root = await fixtureRoot(), outside = await fixtureRoot(); await writeWorkflow(root,"valid");
    const escaping = config("escape"); escaping.execution.file = "../valid/execution.api.json"; await writeWorkflow(root,"escape",escaping);
    await writeWorkflow(outside,"linked",config("external"));
    await symlink(path.join(outside,"linked"),path.join(root,"external"),process.platform === "win32" ? "junction" : "dir");
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows.find(workflow => workflow.original?.id === "escape")?.template).toBeUndefined();
    expect(result.workflows.find(workflow => workflow.original?.id === "external")).toBeUndefined();
    expect(result.issues.find(issue => issue.folder === "escape")?.message).toContain("超出");
    expect(result.issues.find(issue => issue.folder === "external")?.message).toContain("超出");
  });
  it("excludes all folders sharing the same workflow identity", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"one"); await writeWorkflow(root,"two"); await writeWorkflow(root,"three");
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toEqual([]); expect(result.issues).toHaveLength(3);
    expect(result.issues.every(issue => issue.message.includes("重复"))).toBe(true);
  });
  it("isolates broken graphs including dangling references and cycles", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"valid");
    const dangling = graph(); dangling["3"].inputs.images = ["missing",0]; await writeWorkflow(root,"dangling",config("dangling"),dangling);
    const cycle = graph(); cycle["1"].inputs = {...cycle["1"].inputs, dependency:["3",0]} as typeof cycle["1"]["inputs"]; await writeWorkflow(root,"cycle",config("cycle"),cycle);
    await writeWorkflow(root,"editor",config("editor"),{nodes:[],links:[]});
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(4);
    expect(result.workflows.filter(workflow => workflow.template)).toHaveLength(1);
    expect(result.issues.find(issue => issue.folder === "dangling")?.message).toContain("不存在");
    expect(result.issues.find(issue => issue.folder === "cycle")?.message).toContain("循环");
    expect(result.issues.find(issue => issue.folder === "editor")?.message).toContain("编辑器格式");
  });
  it("uses declared model requirements and accepts wrapped API prompt JSON", async () => {
    const root = await fixtureRoot(); const cfg = {...config(),execution:{file:"execution.api.json",modelRequirementsFile:"model.requirements.json"}};
    await writeWorkflow(root,"VideoDeep",cfg,{prompt:graph()});
    await writeFile(path.join(root,"VideoDeep","model.requirements.json"),JSON.stringify({items:[{name:"declared.safetensors",relativePath:"depth/declared.safetensors",required:true}]}));
    const result = await readWorkflowLibrary(root);
    expect(result.issues).toEqual([]);
    expect(result.workflows[0].original?.models).toEqual([{name:"declared.safetensors",relativePath:"depth/declared.safetensors",required:true}]);
  });
  it("does not read a linked execution file outside its workflow folder", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"valid");
    const target = path.join(root,"linked"); await mkdir(target);
    await writeFile(path.join(target,"workflow.config.json"),JSON.stringify({...config("linked"),execution:{file:"outside/execution.api.json"}}));
    await symlink(path.join(root,"valid"),path.join(target,"outside"),process.platform === "win32" ? "junction" : "dir");
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows.find(workflow => workflow.original?.id === "linked")?.template).toBeUndefined();
    expect(result.issues.find(issue => issue.folder === "linked")?.message).toContain("超出");
  });
  it("registers a valid config even when its execution file is missing", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"missing-execution",config("missing"));
    await rm(path.join(root,"missing-execution","execution.api.json"));
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({name:"视频转深度",family:"视频转换",library:{executionIssue:expect.any(String)},original:{executionStatus:"missing"}});
    expect(result.workflows[0].template).toBeUndefined();
  });
  it("excludes invalid configs while registering valid neighbors", async () => {
    const root = await fixtureRoot(); await writeWorkflow(root,"valid");
    await writeWorkflow(root,"no-id",{...config(),id:""}); await writeWorkflow(root,"bad-kind",{...config("bad-kind"),nodeKind:"unknown"});
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(1); expect(result.issues).toHaveLength(2);
  });
  it("supports SaveImageAdvanced and the unique text preview output without guessing Save Text File history", async () => {
    const root = await fixtureRoot();
    const imageGraph = {...graph(),"4":{class_type:"SaveImageAdvanced",inputs:{images:["3",0],filename_prefix:"image"}}};
    await writeWorkflow(root,"advanced-image",{...config("advanced-image"),nodeKind:"image"},imageGraph);
    const textGraph = {"1":graph()["1"],"2":{class_type:"easy showAnything",inputs:{anything:["1",0],text:""}},"3":{class_type:"Save Text File",inputs:{text:["2",0],path:"original-path"}}};
    await writeWorkflow(root,"text-preview",{...config("text-preview"),nodeKind:"text",parameters:[]},textGraph);
    await writeWorkflow(root,"only-save-text",{...config("only-save-text"),nodeKind:"text",parameters:[]},{"1":graph()["1"],"3":{class_type:"Save Text File",inputs:{text:["1",0],path:"original-path"}}});
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(3);
    expect(result.workflows.find(workflow => workflow.original?.id === "advanced-image")?.output).toMatchObject({nodeId:"4",field:"images",kind:"image"});
    expect(result.workflows.find(workflow => workflow.original?.id === "text-preview")?.output).toEqual({nodeId:"2",field:"text",kind:"text"});
    expect(result.workflows.find(workflow => workflow.original?.id === "only-save-text")?.template).toBeUndefined();
  });
  it("fails missing roots so clients can retain the previous successful snapshot", async () => {
    const root = await fixtureRoot();
    await expect(readWorkflowLibrary(path.join(root,"missing"))).rejects.toThrow("无法读取");
  });
});

describe.each(["configureServer","configurePreviewServer"] as const)("%s local endpoint", hook => {
  it("reads only the configured library and rejects cross-origin or arbitrary path requests", async () => {
    const project = await fixtureRoot(), library = path.join(project,"library");
    await mkdir(library); await writeWorkflow(library,"VideoDeep");
    await writeFile(path.join(project,"workflow-library.settings.json"),JSON.stringify({sourcePath:library}));
    let handler: (req:IncomingMessage,res:ServerResponse,next:()=>void)=>void = () => {throw new Error("Hook did not register");};
    const plugin = workflowLibraryPlugin(project);
    (plugin[hook] as (server:unknown)=>void)({middlewares:{use:(fn:typeof handler) => {handler = fn;}}});
    const server = createServer((req,res) => handler(req,res,() => {res.statusCode = 404;res.end();}));
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Server not listening");
    const base = "http://127.0.0.1:" + address.port;
    try {
      const successful = await fetch(base + "/__canvas/workflow-library");
      expect(successful.status).toBe(200); expect((await successful.json()).workflows).toHaveLength(1);
      expect(successful.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(base + "/__canvas/workflow-library?path=C:/",{headers:{Origin:base}})).status).toBe(405);
      expect((await fetch(base + "/__canvas/workflow-library",{headers:{Origin:"https://unrelated.example"}})).status).toBe(403);
      expect((await fetch(base + "/__canvas/workflow-library",{method:"POST"})).status).toBe(405);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

const originalLibrary = "E:/123/DFCine/DFCine0.26/workflows/library";
it.skipIf(!existsSync(originalLibrary))("reads the current installed library without reviving removed folders", async () => {
  const configFile = path.join(originalLibrary,"VideoDeep/workflow.config.json");
  const executionFile = path.join(originalLibrary,"VideoDeep/execution.comfyui.dfenc");
  const deepExists = existsSync(configFile) && existsSync(executionFile);
  const before = deepExists ? await Promise.all([readFile(configFile),readFile(executionFile),stat(executionFile)]) : undefined;
  const result = await readWorkflowLibrary(originalLibrary);
  console.info(JSON.stringify({scanned:result.scanned,registered:result.workflows.length,executable:result.workflows.filter(workflow => workflow.template).length,issueCount:result.issues.length,newEntries:result.workflows.filter(workflow => ["qwen.image21.edit","qwen.image21.t2i","Qwen.Prompt.Reverse"].includes(workflow.original?.id ?? "")).map(workflow => ({folder:workflow.library?.folder,output:workflow.output,issue:workflow.library?.executionIssue}))}));
  const deep = result.workflows.find(workflow => workflow.original?.id === "video.deep");
  if (!deepExists) { expect(deep).toBeUndefined(); return; }
  expect(deep).toBeDefined(); expect(deep?.name).toBe("视频转深度");
  expect(deep?.mapping).toContainEqual({semantic:"slot:input1",nodeId:"1",field:"video",pathMode:"comfy-input"});
  expect(deep?.mapping).toContainEqual({semantic:"resolution3",nodeId:"3",field:"resolution"});
  expect(deep?.output).toMatchObject({kind:"video",field:"gifs"});
  expect(deep?.original?.executionStatus).toBe("encrypted");
  const merged = withBuiltinBindings([], result.workflows, result.sourcePath);
  const flashEntries = merged.filter(workflow => workflow.original?.id === "flashvsr-video-upscale");
  expect(flashEntries).toHaveLength(1);
  expect(flashEntries[0].id).toBe("dfcine-v2-video-video-upscale-flashvsr");
  expect(flashEntries[0].template).toBeDefined();
  const after = await Promise.all([readFile(configFile),readFile(executionFile),stat(executionFile)]);
  expect(after[0]).toEqual(before![0]); expect(after[1]).toEqual(before![1]); expect(after[2].mtimeMs).toBe(before![2].mtimeMs);
});

describe("automatic model categories after an incomplete import", () => {
  it("rereads the retained source for an old broad category without changing saved workflow files", async () => {
    const root = await fixtureRoot(), id = "custom." + "f".repeat(64), folder = "Unresolved-graph";
    const source = {
      model: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors" } },
      output: { class_type: "SaveImage", inputs: { images: ["model", 0] } },
    };
    const savedConfig = { ...config(id), primaryCategoryLabel: "图像生成", nodeKind: "image", inputs: [], parameters: [],
      importState: { status: "pending", format: "api", diagnostics: [], warnings: [] } };
    await writeWorkflow(root, folder, savedConfig, { canvasImportState: "pending", workflowId: id });
    const configPath = path.join(root, folder, "workflow.config.json"), sourcePath = path.join(root, folder, "source.json");
    await writeFile(sourcePath, JSON.stringify(source));
    const originalConfig = await readFile(configPath, "utf8"), originalSource = await readFile(sourcePath, "utf8");
    const result = await readWorkflowLibrary(root);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].family).toBe("Qwen 图像");
    expect(result.workflows[0].library?.importStatus).toBe("pending");
    expect(result.workflows[0].original?.id).toBe(id);
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect(await readFile(sourcePath, "utf8")).toBe(originalSource);
  });
});
