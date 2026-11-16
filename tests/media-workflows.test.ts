import { describe, expect, it } from "vitest";
import { musicWorkflows } from "../src/workflow/music";
import { imageWorkflows } from "../src/workflow/image";
import { speechWorkflows } from "../src/workflow/speech";
import { twoPassWorkflows } from "../src/workflow/two-pass";
import { toolWorkflows } from "../src/workflow/tools";
import { validateDefinition, buildWorkflow } from "../src/workflow-adapter/adapter";
import { createNode } from "../src/stores/store";
import { outputFiles } from "../src/comfyui/client";
import { migrateProject } from "../src/projects/migrate";
import { useStore } from "../src/stores/store";

describe("music and image recipes", () => {
  it.each([...twoPassWorkflows, ...toolWorkflows])("validates $name without exposing disconnected placeholder inputs", (w) => {
    expect(() => validateDefinition(w)).not.toThrow();
    if (w.mode === "text-to-image") expect(Object.values(w.template!).some(n => n.class_type === "LoadImage")).toBe(false);
    if (w.mode === "image-to-image") expect(w.requiredInputs).toEqual(["image"]);
  });
  it.each([...musicWorkflows, ...imageWorkflows, ...speechWorkflows.filter(w => w.mode === "text-to-audio")])("validates $name and isolates output paths", (w) => {
    expect(() => validateDefinition(w)).not.toThrow();
    const node = createNode(w.output.kind === "audio" ? "audio" : "image-generation", 1);
    node.data.generation!.prompt = "A test composition";
    node.data.generation!.params = { seed: 58 };
    const before = JSON.stringify(w.template);
    const { workflow: graph } = buildWorkflow(w, node, [], {}, "infinite-canvas/task-1/result");
    expect(graph.save.inputs.filename_prefix).toBe("infinite-canvas/task-1/result");
    expect(JSON.stringify(w.template)).toBe(before);
  });
  it("requires accurate transcripts for speech continuation and detailed cloning", () => {
    for (const id of ["voxcpm2-prompt_continuation", "voxcpm2-ultimate_clone"]) {
      const w = speechWorkflows.find(w => w.id === id)!;
      expect(() => validateDefinition(w)).not.toThrow();
      const n = createNode("audio", 1);
      n.data.generation!.params = {};
      expect(() => buildWorkflow(w, n, [], {})).toThrow("参考音频准确转写");
      expect(w.requiredInputs).toContain("referenceAudio");
    }
  });
  it("keeps Music3 planning and diffusion on the same seed and actual planned duration", () => {
    const w = musicWorkflows[0];
    const node = createNode("audio", 1);
    node.data.generation!.params = { seed: 123, duration: 12, lyrics: "[Verse]\nHello", tuning: "Fast Draft" };
    const { workflow: g } = buildWorkflow(w, node, [], {});
    expect(g.encode.inputs.seed).toEqual(g.sampler.inputs.seed);
    expect(g.seed.inputs.base_seed).toBe(123);
    expect(g.encode.inputs.max_duration).toBe(12);
    expect(g.latent.inputs.seconds).toEqual(["encode", 1]);
    expect(g.lyrics.inputs.lyrics).toBe("[Verse]\nHello");
    expect(g.sampler.inputs.steps).toEqual(["tuning", 3]);
    expect(outputFiles({ outputs: { save: { audio: [{ filename: "song.mp3", type: "output" }] } } }, w)).toEqual([{ filename: "song.mp3", type: "output", subfolder: "" }]);
  });
  it("adds generation to existing audio nodes without losing their assets or edges", () => {
    const project = structuredClone(useStore.getState().project);
    const audio = createNode("audio", 1);
    delete audio.data.generation;
    audio.data.assetId = "original-audio";
    const source = createNode("text", 2);
    source.data.text = "Retained lyrics";
    const edge = { id: "retained-audio-edge", source: source.id, target: audio.id, data: { role: "prompt" as const, order: 1 } };
    project.canvases[0].nodes = [audio, source];
    project.canvases[0].edges = [edge];
    const result = migrateProject(project);
    expect(result.canvases[0].nodes[0].data.assetId).toBe("original-audio");
    expect(result.canvases[0].nodes[0].data.generation?.workflowId).toBe("dfcine-v2-music-minimax-music-music3");
    expect(result.canvases[0].edges).toEqual([edge]);
    expect(result.canvases[0].nodes[1].data.text).toBe("Retained lyrics");
    expect(project.canvases[0].nodes[0].data.generation).toBeUndefined();
    expect(migrateProject(result)).toEqual(result);
  });
});
