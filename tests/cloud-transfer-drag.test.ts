import { describe, expect, it } from "vitest";
import { createLocalTransferDrag, isLocalTransferDrag } from "../src/settings/cloud-transfer-drag";

describe("existing local file drag", () => {
  it("uploads a checked file with every checked file and folder", () => {
    const selection = new Set(["nodes/插件", "MiniMax - H3.json"]);
    const drag = createLocalTransferDrag("comfyui_nodes", "MiniMax - H3.json", selection);
    expect(drag).toEqual({ bucket: "comfyui_nodes", paths: ["nodes/插件", "MiniMax - H3.json"] });
    expect([...selection]).toEqual(["nodes/插件", "MiniMax - H3.json"]);
  });

  it("starts with only the dragged row when that row was not checked", () => {
    expect(createLocalTransferDrag("loras", "portrait.safetensors", new Set(["other.safetensors"])))
      .toEqual({ bucket: "loras", paths: ["portrait.safetensors"] });
  });

  it("keeps the source bucket and paths stable while the displayed selection changes", () => {
    const selection = new Set(["custom-node", "workflow.json"]);
    const drag = createLocalTransferDrag("comfyui_nodes", "custom-node", selection);
    selection.clear(); selection.add("new-file");
    expect(drag).toEqual({ bucket: "comfyui_nodes", paths: ["custom-node", "workflow.json"] });
    expect(isLocalTransferDrag(JSON.stringify(drag), drag)).toBe(true);
  });

  it("does not accept text, another source bucket, or a modified file selection", () => {
    const drag = createLocalTransferDrag("uploads", "file.json", new Set());
    for (const value of ["file.json", "", "{", JSON.stringify({ bucket: "loras", paths: drag.paths }), JSON.stringify({ ...drag, paths: ["different.json"] })]) {
      expect(isLocalTransferDrag(value, drag)).toBe(false);
    }
  });
});
