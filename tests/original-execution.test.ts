import { describe, expect, it } from "vitest";
import { catalog, defaults } from "../src/workflow/catalog";
import { buildWorkflow, validateDefinition } from "../src/workflow-adapter/adapter";
import { prepareForServer } from "../src/workflow-adapter/preflight";
import { resolveInputs, type ResolvedInput } from "../src/semantic/resolver";
import { resolvePrompt } from "../src/semantic/prompt";
import type { Canvas, CanvasNode, WorkflowDefinition, Asset } from "../src/types";

function node(w: WorkflowDefinition): CanvasNode {
  return {id:"target",position:{x:0,y:0},data:{kind:"video",title:"Test",generation:{workflowId:w.id,prompt:"local description",negativePrompt:"",params:{...defaults(w),...Object.fromEntries(w.parameters.filter(p=>p.inputText).map(p=>[p.key,"dedicated text"]))},taskId:null}}};
}
function input(kind: "image"|"video"|"audio", i: number, semantic: string): ResolvedInput {
  const asset: Asset = {id:kind+i,kind,name:kind+i+(kind==="image"?".png":kind==="video"?".mp4":".wav"),mime:kind+"/test",size:1,createdAt:0};
  return {asset,semantic,edgeId:asset.id,order:i};
}
describe("original directory execution", () => {
  for (const w of catalog.filter(w=>w.template)) it("builds bindings without inference: " + w.name + " / " + w.family, () => {
    validateDefinition(w);
    const inputs = w.dynamicReferences ? [input("image",0,"dynamic:image"),input("video",1,"dynamic:video"),input("audio",2,"dynamic:audio")]
      : (w.inputSlots??[]).map((s,i)=>input(s.kind,i,s.semantic));
    const uploaded = Object.fromEntries(inputs.map(i=>[i.asset.id,"infinite-canvas/task/"+i.asset.name]));
    const built=buildWorkflow(w,node(w),inputs,uploaded,"infinite-canvas/task/result");
    expect(built.workflow[w.output.nodeId]).toBeTruthy();
    for (const map of w.mapping) {
      const value=built.workflow[map.nodeId].inputs[map.field];
      if (map.semantic==="prompt") expect(value).toBe("local description");
      if (map.semantic.startsWith("slot:") && !w.parameters.some(p=>p.key===map.semantic)) expect(String(value)).toContain("infinite-canvas/task/");
    }
    for (const n of Object.values(built.workflow)) for (const value of Object.values(n.inputs))
      if (Array.isArray(value) && value.length===2 && typeof value[0]==="string" && typeof value[1]==="number") expect(built.workflow[value[0]], value[0]).toBeTruthy();
    expect(built.workflow[w.output.nodeId].inputs.filename_prefix).toBe("infinite-canvas/task/result");
  });
  it("removes unused H3 reference prototypes and creates every selected image", () => {
    const w=catalog.find(w=>w.id==="dfcine-v2-video-h3-standard-references")!;
    const inputs=[0,1,2].map(i=>input("image",i,"dynamic:image"));
    const graph=buildWorkflow(w,node(w),inputs,Object.fromEntries(inputs.map(i=>[i.asset.id,"task/"+i.asset.name]))).workflow;
    const target=graph[w.dynamicReferences!.binding.targetNodeId];
    expect(Object.keys(target.inputs).filter(k=>k.startsWith("ref_images."))).toHaveLength(3);
    expect(Object.keys(target.inputs).filter(k=>k.startsWith("ref_videos.")||k.startsWith("ref_audios."))).toHaveLength(0);
    expect(graph["150"]).toBeUndefined();
  });
  it("routes connected lyrics separately from the music description", () => {
    const w=catalog.find(w=>w.id==="dfcine-v2-music-minimax-music-music3")!;
    const canvas: Canvas={id:"c",name:"c",sceneId:"s",viewport:{x:0,y:0,zoom:1},nodes:[{id:"lyrics",position:{x:0,y:0},data:{kind:"text",title:"Lyrics",text:"verse"}},node(w)],edges:[{id:"e",source:"lyrics",target:"target"}]};
    const resolved=resolvePrompt(canvas,"target","piano",w);
    expect(resolved.prompt).toBe("piano");expect(resolved.slotParams).toEqual({"slot:input1":"verse"});
  });
  it("requires all three Qwen reference images", () => {
    const w=catalog.find(w=>w.id==="dfcine-v2-image-qwen-triple-edit")!;
    const a=input("image",0,"auto").asset;
    const canvas: Canvas={id:"c",name:"c",sceneId:"s",viewport:{x:0,y:0,zoom:1},nodes:[{id:"a",position:{x:0,y:0},data:{kind:"reference",title:"A",assetId:a.id}},node(w)],edges:[{id:"e",source:"a",target:"target"}]};
    expect(()=>resolveInputs(canvas,"target",w,{[a.id]:a})).toThrow("请连接素材");
  });
  it("canonicalizes exact model filenames only and rejects missing weights", () => {
    const graph={"1":{class_type:"Loader",inputs:{model:"folder\\same.safetensors"}},"2":{class_type:"Save",inputs:{data:["1",0]}},"unused":{class_type:"Missing",inputs:{}}};
    const info={Loader:{input:{required:{model:[["same.safetensors"]]}}},Save:{}};
    expect(prepareForServer(graph,"2",info)["1"].inputs.model).toBe("same.safetensors");
    expect(prepareForServer(graph,"2",info).unused).toBeUndefined();
    expect(()=>prepareForServer(graph,"2",{...info,Loader:{input:{required:{model:[["other.safetensors"]]}}}})).toThrow("未提供这些模型选项");
    expect(()=>prepareForServer(graph,"2",{Save:{}})).toThrow("未注册节点");
  });
});
