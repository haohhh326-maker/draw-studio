import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode } from "../src/types";
import type { ImportAnalysis } from "../src/workflow/import-analyzer";
import { runningHubBindingFieldChoices } from "../src/runninghub/RunningHubWorkflowDialog";
import {
  prepareRunningHubApp,
  prepareRunningHubWorkflow,
  prepareRunningHubWorkflowCandidates,
} from "../src/runninghub/workflows";
import {
  runningHubCanvasParameterKeys,
  runningHubSelectableParameters,
} from "../src/runninghub/source-summary";
import { reviewRunningHubImportBindings, runningHubFieldKey } from "../src/runninghub/import-review";
import { analyzeRunningHubUpstream } from "../src/runninghub/upstream-reader";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { withRunningHubAppReader, withRunningHubWorkflowReader } from "./runninghub-test-reader";

const source: ApiWorkflow = {
  prompt: {
    class_type: "TextInput",
    inputs: { prompt: "sample", text: "saved custom prompt" },
  },
  image: {
    class_type: "LoadImage",
    inputs: { image: "sample.png", custom_path: "saved-custom.png" },
  },
  model: {
    class_type: "UNETLoader",
    inputs: { unet_name: "model.safetensors", api_key: "fixture-node-key" },
  },
  nullable: { class_type: "RunningHubAppInput", inputs: { image: null } },
};
const analysis: ImportAnalysis = {
  fields: Object.entries(source).flatMap(([nodeId, node]) =>
    Object.entries(node.inputs).flatMap(([field, value]) =>
      typeof value === "string"
        ? [{ nodeId, field, value, label: nodeId + "." + field }]
        : [],
    ),
  ),
  prompts: [
    { nodeId: "prompt", field: "prompt", label: "Prompt", value: "sample" },
  ],
  inputs: [
    {
      nodeId: "image",
      field: "image",
      label: "Image",
      kind: "image",
      required: true,
    },
    {
      nodeId: "nullable",
      field: "image",
      label: "Optional image",
      kind: "image",
      required: false,
    },
  ],
  outputs: [],
  warnings: [],
  errors: [],
};
const credentials = new Set([JSON.stringify(["model", "api_key"])]);
const identity = (field: { nodeId: string; field: string }) =>
  field.nodeId + "." + field.field;

describe("RunningHub ordinary and custom binding choices", () => {
  it("keeps both colliding published AI app text options selectable when opening and reviewing a saved app", async () => {
    const pairs = [["scene", "style.prompt", "甲"], ["scene.style", "prompt", "乙"]] as const;
    const name = "双提示词应用";
    const app = await withRunningHubAppReader({
      name, apiVersion: "v2",
      nodeInfoList: pairs.map(([nodeId, fieldName, fieldValue]) => ({ nodeId, fieldName, fieldValue, fieldType: "STRING" })),
    });
    const graph = app.reader.workflow!;
    const original = structuredClone(graph);
    const analysis = analyzeRunningHubUpstream(app.reader);
    const fresh = reviewRunningHubImportBindings(graph, analysis);
    const choices = runningHubBindingFieldChoices(graph, analysis, fresh.promptKey, [], new Set()).promptFields;
    const keys = pairs.map(([nodeId, field]) => JSON.stringify([nodeId, field]));
    expect(choices.map(field => runningHubFieldKey(field.nodeId, field.field)).sort()).toEqual([...keys].sort());
    expect(keys).toContain(fresh.promptKey);
    for (const [nodeId, field] of pairs) {
      const promptKey = JSON.stringify([nodeId, field]);
      const { workflow } = prepareRunningHubApp(app, { workflowId: "123", baseUrl: "https://www.runninghub.cn",
        name, promptKey, reader: app.reader });
      expect(workflow.mapping.filter(item => item.semantic === "prompt")).toEqual([{ semantic: "prompt", nodeId, field }]);
      expect(reviewRunningHubImportBindings(graph, analysis, workflow).promptKey).toBe(promptKey);
      const canvas = { data: { generation: { workflowId: workflow.id, prompt: "画布提示词", negativePrompt: "", params: {}, taskId: null } } } as CanvasNode;
      const expected = structuredClone(original);
      expected[nodeId].inputs[field] = "画布提示词";
      expect(buildWorkflow(workflow, canvas, [], {}).workflow).toEqual(expected);
    }
    expect(graph).toEqual(original);
  });

  it("limits ordinary choices to recognized prompt/media ports without losing nullable declared inputs", () => {
    const choices = runningHubBindingFieldChoices(
      source,
      analysis,
      JSON.stringify(["prompt", "prompt"]),
      [],
      credentials,
    );
    expect(choices.promptFields.map(identity)).toEqual(["prompt.prompt"]);
    expect(choices.mediaFields.map(identity)).toEqual([
      "image.image",
      "nullable.image",
    ]);
  });

  it("keeps reviewed custom bindings visible after the custom field picker is closed", () => {
    const choices = runningHubBindingFieldChoices(
      source,
      analysis,
      JSON.stringify(["prompt", "text"]),
      [
        {
          nodeId: "image",
          field: "custom_path",
          kind: "image",
          required: true,
        },
      ],
      credentials,
    );
    expect(choices.promptFields.map(identity)).toEqual([
      "prompt.prompt",
      "prompt.text",
    ]);
    expect(choices.mediaFields.map(identity)).toEqual([
      "image.image",
      "image.custom_path",
      "nullable.image",
    ]);
    expect(choices.promptFields.some((field) => field.nodeId === "model")).toBe(
      false,
    );
  });

  it("expands custom choices explicitly while never offering a credential port as a prompt or media field", () => {
    const choices = runningHubBindingFieldChoices(
      source,
      analysis,
      "",
      [],
      credentials,
      true,
    );
    expect(choices.promptFields.map(identity)).toContain("model.unet_name");
    expect(choices.mediaFields.map(identity)).toContain("model.unet_name");
    expect(
      [...choices.promptFields, ...choices.mediaFields].map(identity),
    ).not.toContain("model.api_key");
    expect(
      choices.mediaFields.filter((field) => field.nodeId === "nullable"),
    ).toHaveLength(1);
    expect(source.nullable.inputs.image).toBeNull();
  });
});

describe("RunningHub selected binding editor candidates", () => {
  const graph: ApiWorkflow = {
    "1": {
      class_type: "ImageGenerator",
      inputs: {
        prompt: "sample",
        seed: 1,
        steps: 20,
        custom_value: "fixed",
        provider_api_key: "fixture-author-key",
      },
    },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
  const options = {
    workflowId: "42",
    baseUrl: "https://www.runninghub.cn",
    name: "Fixture",
    promptKey: "1.prompt",
    mediaInputs: [],
    outputs: [{ nodeId: "2", field: "images", kind: "image" as const }],
  };

  it("reconstructs every source checkbox candidate from a saved pruned definition and preserves the reviewed selection", async () => {
    const readOptions = await withRunningHubWorkflowReader(graph, options);
    const original = prepareRunningHubWorkflowCandidates(graph, readOptions).workflow;
    const keyFor = (workflow: typeof original, field: string) => workflow.mapping.find(binding => binding.nodeId === "1" && binding.field === field)!.semantic;
    const steps = keyFor(original, "steps");
    const saved = prepareRunningHubWorkflow(graph, {
      ...readOptions,
      canvasParameterKeys: [steps],
    }).workflow;
    expect(saved.runninghub?.bindingMode).toBe("selected");
    expect(
      saved.parameters
        .filter((parameter) => !parameter.secret)
        .map((parameter) => parameter.key),
    ).toEqual([steps]);
    expect(
      saved.parameters.find(
        (parameter) => parameter.key === keyFor(saved, "provider_api_key"),
      ),
    ).toMatchObject({ secret: true, default: "" });
    const candidate = prepareRunningHubWorkflowCandidates(
      saved.template,
      await withRunningHubWorkflowReader(saved.template, options),
    ).workflow;
    expect(
      runningHubSelectableParameters(candidate).map(
        (parameter) => parameter.key,
      ),
    ).toEqual(["custom_value", "seed", "steps"].map(field => keyFor(candidate, field)));
    const selected = runningHubCanvasParameterKeys(
      candidate,
      saved.runninghub?.canvasParameterKeys,
    );
    expect(selected).toEqual([keyFor(candidate, "steps")]);
    const updated = prepareRunningHubWorkflow(candidate.template, {
      ...await withRunningHubWorkflowReader(candidate.template, options),
      canvasParameterKeys: [...selected, keyFor(candidate, "custom_value")],
    }).workflow;
    expect(
      updated.parameters
        .filter((parameter) => !parameter.secret)
        .map((parameter) => parameter.key),
    ).toEqual([keyFor(updated, "custom_value"), keyFor(updated, "steps")]);
    expect(new Set(updated.mapping.map((binding) => binding.semantic))).toEqual(new Set([
      "prompt", keyFor(updated, "steps"), keyFor(updated, "custom_value"), keyFor(updated, "provider_api_key"),
    ]));
    expect(updated.template?.["1"].inputs).toMatchObject({
      seed: 1,
      custom_value: "fixed",
    });
    expect(updated.template).toEqual(saved.template);
  });

  it("keeps an explicitly empty saved selection empty on edit while the complete source choices remain available", async () => {
    const saved = prepareRunningHubWorkflow(graph, {
      ...await withRunningHubWorkflowReader(graph, options),
      canvasParameterKeys: [],
    }).workflow;
    const candidate = prepareRunningHubWorkflowCandidates(
      saved.template,
      await withRunningHubWorkflowReader(saved.template, options),
    ).workflow;
    expect(runningHubSelectableParameters(candidate)).toHaveLength(3);
    expect(
      runningHubCanvasParameterKeys(
        candidate,
        saved.runninghub?.canvasParameterKeys,
      ),
    ).toEqual([]);
    const resaved = prepareRunningHubWorkflow(candidate.template, {
      ...await withRunningHubWorkflowReader(candidate.template, options),
      canvasParameterKeys: [],
    }).workflow;
    expect(resaved.parameters.filter((parameter) => !parameter.secret)).toEqual(
      [],
    );
    expect(resaved.mapping.map((binding) => binding.field)).toEqual(["prompt", "provider_api_key"]);
    expect(resaved.template).toEqual(saved.template);
  });
});
