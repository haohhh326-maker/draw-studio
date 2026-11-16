import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, GenerationTask, Project } from "../src/types";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { catalog, defaultConnection } from "../src/workflow/catalog";
import { migrateProject } from "../src/projects/migrate";
const image = (extra: Partial<Asset> = {}): Asset => ({ id: "image", name: "image.png", kind: "image", mime: "image/png", size: 1, createdAt: 1, ...extra });
beforeEach(() => {
  records.clear();
  const project: Project = { version: 2, id: "p", name: "尺寸恢复", activeCanvasId: "c", scenes: [],
    canvases: [{ id: "c", name: "画布", sceneId: "s", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }],
    assets: {}, tasks: {}, history: [], updatedAt: 1 };
  useStore.setState({ project, projects: {}, workflows: [], ready: false, projectOpen: true, past: [], future: [], connection: defaultConnection });
});
describe("media dimensions in canvas persistence", () => {
  it("keeps imported materials as numbered references through replacement, save and legacy restore", async () => {
    const assets: Asset[] = [image(), image({id:"video",name:"shot.mp4",kind:"video",mime:"video/mp4"}),
      image({id:"audio",name:"voice.wav",kind:"audio",mime:"audio/wav"}),
      image({id:"text",name:"notes.txt",kind:"text",mime:"text/plain",text:"notes"}),
      image({id:"file",name:"data.pdf",kind:"file",mime:"application/pdf"})];
    assets.forEach(asset => useStore.getState().addAsset(asset,{x:0,y:0}));
    const original=structuredClone(useStore.getState().project);
    expect(original.canvases[0].nodes.map(node => [node.data.kind,node.data.title])).toEqual(
      assets.map((_asset,index) => ["reference","参考 " + (index+1)]));
    const first=original.canvases[0].nodes[0];
    useStore.getState().addAsset(image({id:"replacement",name:"new.png"}),{x:0,y:0},first.id);
    expect(useStore.getState().project.canvases[0].nodes[0].data.title).toBe("参考 1");
    await useStore.getState().save(true);
    const saved=records.get("project-library") as Record<string,{project:Project}>;
    expect(saved.p.project.canvases[0].nodes[0].data.title).toBe("参考 1");
    expect(saved.p.project.assets.replacement.name).toBe("new.png");
    original.canvases[0].nodes[0].data.title=assets[0].name;
    original.canvases[0].nodes[1].data.title="角色参考";
    original.canvases[0].nodes[2].data.title=assets[2].name;
    original.canvases[0].edges=[{id:"edge",source:first.id,target:original.canvases[0].nodes[1].id,data:{role:"auto",order:1}}];
    const restored=migrateProject(original,[]);
    expect(restored.canvases[0].nodes[0].data.title).toBe("参考 1");
    expect(restored.canvases[0].nodes[1].data.title).toBe("角色参考");
    expect(restored.canvases[0].nodes[2].data.title).toBe("参考 2");
    expect(restored.assets).toEqual(original.assets);
    expect(restored.canvases[0].edges).toEqual(original.canvases[0].edges);
    expect(migrateProject(restored,[])).toEqual(restored);
  });
  it("sizes new uploads to their original ratio and saves both dimensions and frame", async () => {
    useStore.getState().addAsset(image({ width: 640, height: 360 }), { x: 10, y: 20 });
    const project = useStore.getState().project, node = project.canvases[0].nodes[0];
    expect(node.style).toMatchObject({ width: 360, height: 203 });
    expect(node.data.mediaLayoutAssetId).toBe("image");
    await useStore.getState().save(true);
    const saved = records.get("project-library") as Record<string, { project: Project }>;
    expect(saved.p.project.assets.image).toMatchObject({ width: 640, height: 360 });
    expect(saved.p.project.canvases[0].nodes[0].style).toEqual(node.style);
    useStore.getState().addAsset(image({ id: "portrait", width: 360, height: 640 }), { x: 400, y: 20 }, node.id);
    expect(useStore.getState().project.canvases[0].nodes[0].style).toMatchObject({ width: 203, height: 360 });
  });
  it("repairs legacy asset references across canvases once, preserving later manual resizing", () => {
    useStore.getState().addAsset(image(), { x: 0, y: 0 });
    const first = useStore.getState().project.canvases[0];
    useStore.getState().editProject(p => ({ ...p, canvases: [...p.canvases, { ...first, id: "second", nodes: first.nodes.map(n => ({ ...n, id: "copy" })) }] }));
    useStore.getState().setAssetDimensions("image", 1080, 1920);
    expect(useStore.getState().project.canvases.every(c => c.nodes[0].style?.height === 360)).toBe(true);
    useStore.getState().editCanvas(c => ({ ...c, nodes: c.nodes.map(n => ({ ...n, style: { ...n.style, width: 270, height: 480 } })) }));
    const manuallySized = useStore.getState().project;
    useStore.getState().setAssetDimensions("image", 1080, 1920);
    expect(useStore.getState().project).toBe(manuallySized);
    useStore.getState().setAssetDimensions("image", 0, Infinity);
    expect(useStore.getState().project).toBe(manuallySized);
  });
  it("fits a generated result to its source ratio without altering task or history snapshots", () => {
    const id = useStore.getState().addNode("video");
    useStore.getState().patchNode(id, { generation: { prompt: "", negativePrompt: "", workflowId: "w", params: {}, taskId: "task" } });
    const task: GenerationTask = { taskId: "task", promptId: "prompt", executorType: "comfyui", requestId: "request", clientId: "client", canvasId: "c", nodeId: id, nodeTitle: "视频", status: "saving", createdAt: 1, updatedAt: 1, connection: defaultConnection, workflow: structuredClone(catalog[0]), input: { prompt: "", negativePrompt: "", params: {}, assets: [] }, outputs: [] };
    useStore.getState().createTask(task);
    const output = image({ id: "result", name: "result.mp4", kind: "video", mime: "video/mp4", width: 1920, height: 1080 });
    useStore.getState().complete("task", [output], { id: "history", canvasId: "c", nodeId: id, nodeTitle: "视频", workflowId: "w", prompt: "", negativePrompt: "", params: {}, inputs: [], outputs: [output.id], promptId: "prompt", createdAt: 1 });
    const current = useStore.getState().project;
    expect(current.canvases[0].nodes[0].style).toMatchObject({ width: 360, height: 203 });
    expect(current.tasks.task.workflow).toEqual(task.workflow);
    expect(current.history[0].promptId).toBe("prompt");
  });
  it("preserves a newer generated result's dimensions when undo restores an older canvas snapshot", () => {
    const id = useStore.getState().addNode("video");
    const previous = image({id:"previous",name:"previous.mp4",kind:"video",mime:"video/mp4",width:1080,height:1920});
    useStore.getState().addAsset(previous,{x:0,y:0},id);
    useStore.getState().editCanvas(canvas => ({...canvas,nodes:canvas.nodes.map(node => ({...node,style:{...node.style,borderColor:"#fff"}}))}));
    useStore.getState().checkpoint();
    useStore.getState().patchNode(id,{generation:{prompt:"",negativePrompt:"",workflowId:"w",params:{},taskId:"task"}});
    const task: GenerationTask = {taskId:"task",promptId:"prompt",executorType:"comfyui",requestId:"request",clientId:"client",canvasId:"c",nodeId:id,nodeTitle:"视频",status:"saving",createdAt:1,updatedAt:1,connection:defaultConnection,workflow:structuredClone(catalog[0]),input:{prompt:"",negativePrompt:"",params:{},assets:[]},outputs:[]};
    useStore.getState().createTask(task);
    const output = image({id:"new-result",name:"result.mp4",kind:"video",mime:"video/mp4",width:1920,height:1080});
    useStore.getState().complete("task",[output],{id:"history",canvasId:"c",nodeId:id,nodeTitle:"视频",workflowId:"w",prompt:"",negativePrompt:"",params:{},inputs:[],outputs:[output.id],promptId:"prompt",createdAt:1});
    useStore.getState().undo();
    const restored = useStore.getState().project.canvases[0].nodes[0];
    expect(restored.data.assetId).toBe("new-result");
    expect(restored.data.mediaLayoutAssetId).toBe("new-result");
    expect(restored.style).toMatchObject({width:360,height:203,borderColor:"#fff"});
    expect(restored.width).toBe(360); expect(restored.height).toBe(203);
    expect(restored.data.generation?.taskId).toBe("task");
    expect(useStore.getState().project.tasks.task.status).toBe("completed");
    expect(useStore.getState().project.history[0].outputs).toEqual(["new-result"]);
  });
  it("still undoes and redoes a manual resize when the same asset is retained", () => {
    const id = useStore.getState().addNode("video");
    useStore.getState().addAsset(image({name:"same.mp4",kind:"video",mime:"video/mp4",width:1920,height:1080}),{x:0,y:0},id);
    useStore.getState().checkpoint();
    useStore.getState().editCanvas(canvas => ({...canvas,nodes:canvas.nodes.map(node => ({...node,width:480,height:270,style:{...node.style,width:480,height:270}}))}));
    useStore.getState().undo();
    const restored = useStore.getState().project.canvases[0].nodes[0];
    expect(restored.data.assetId).toBe("image");
    expect(restored.data.mediaLayoutAssetId).toBe("image");
    expect(restored.style).toMatchObject({width:360,height:203});
    useStore.getState().redo();
    expect(useStore.getState().project.canvases[0].nodes[0].style).toMatchObject({width:480,height:270});
  });
});
