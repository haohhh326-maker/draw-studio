import { describe, expect, it } from "vitest";
import type { Generation, MediaKind, WorkflowDefinition } from "../src/types";
import { workflowSelectionPatch } from "../src/generation/workflow-selection";
import { createPromptDraftSessions } from "../src/prompt-optimization/prompt-drafts";

const example = '<Picture 1> defines the female character. <Audio 1> defines the dialogue.';
function workflow(kind: MediaKind = "video"): WorkflowDefinition {
  return {
    id: "minimax-h3", name: "H3 多参视频", family: "MiniMax H3", mode: "multi-reference",
    requiredInputs: [], optionalInputs: [], defaultPrompt: example,
    parameters: [{ key: "seed", label: "种子", type: "number", default: 58 },
      { key: "duration", label: "时长", type: "number", default: 9 }],
    mapping: [{ semantic: "prompt", nodeId: "prompt", field: "text" }],
    template: { prompt: { class_type: "Text", inputs: { text: example } } },
    output: { nodeId: "output", field: "result", kind },
  };
}
function generation(prompt = ""): Generation {
  return { prompt, workflowId: "old-workflow", negativePrompt: "保留反向提示词", params: { seed: 900, steps: 20 }, taskId: "previous-result" };
}

describe("workflow selection preserves the user's prompt", () => {
  it.each([
    ["image", "image-generation"], ["video", "video"], ["audio", "audio"], ["text", "text"], ["file", "tool"],
  ] as const)("keeps an empty %s prompt empty when selecting a workflow with an example", (output, kind) => {
    const selected = workflowSelectionPatch(generation(), workflow(output));
    expect(selected.kind).toBe(kind);
    expect(selected.generation?.prompt).toBe("");
    expect(selected.generation?.workflowId).toBe("minimax-h3");
  });

  it.each(["用户自己输入的提示词", "<Picture 1> 看向 <Picture 2>，保留 @角色引用。\n下一镜头。", " \n "])(
    "preserves all user text exactly, including references and whitespace: %s", prompt => {
      expect(workflowSelectionPatch(generation(prompt), workflow()).generation?.prompt).toBe(prompt);
    },
  );

  it("applies the selected workflow's parameters without changing prompt, restrictions or previous result", () => {
    const source = generation("我的分镜"), definition = workflow();
    const before = structuredClone({ source, definition });
    const selected = workflowSelectionPatch(source, definition).generation!;
    expect(selected.params).toEqual({ seed: 58, duration: 9 });
    expect(selected.negativePrompt).toBe("保留反向提示词");
    expect(selected.taskId).toBe("previous-result");
    expect(selected.prompt).toBe("我的分镜");
    expect({ source, definition }).toEqual(before);
  });

  it("does not restore the example after clearing a prompt and choosing another model", () => {
    const first = workflowSelectionPatch(generation("我的提示词"), workflow()).generation!;
    const second = workflowSelectionPatch({ ...first, prompt: "" }, { ...workflow(), id: "another-model" }).generation!;
    expect(second.prompt).toBe("");
    expect(second.workflowId).toBe("another-model");
  });

  it.each(["original", "optimized"] as const)("retains both optimization drafts when selecting from the %s version", version => {
    const drafts = createPromptDraftSessions(), key = "node";
    const original = drafts.capture(key, "用户原文");
    drafts.complete(key, original, "优化后的分镜");
    const current = drafts.switchVersion(key, "优化后的分镜", version)!;
    const selected = workflowSelectionPatch(generation(current[version]!), workflow()).generation!;
    drafts.capture(key, selected.prompt);
    expect(drafts.get(key)).toEqual({ original: "用户原文", optimized: "优化后的分镜", version });
    const switched = drafts.switchVersion(key, selected.prompt)!;
    expect(switched[switched.version]).toBe(version === "original" ? "优化后的分镜" : "用户原文");
  });

  it("leaves a newly imported workflow's example in its definition while the new editor starts blank", () => {
    const definition = workflow();
    const selected = workflowSelectionPatch({ ...generation(), taskId: null, negativePrompt: "" }, definition).generation!;
    expect(selected.prompt).toBe("");
    expect(selected.taskId).toBeNull();
    expect(definition.defaultPrompt).toBe(example);
    expect(definition.template?.prompt.inputs.text).toBe(example);
  });
});
