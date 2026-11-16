import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../src/types";
import { withBuiltinBindings } from "../src/workflow/catalog";
import { buildDirectoryView, filterDirectoryWorkflows, workflowSeriesId } from "../src/workflow/directory-view";
import { workflowVisibilityKey } from "../src/workflow/visibility";
import { resolveWorkflowImportFamily } from "../src/workflow/import-category";

const sourceId = "custom." + "a".repeat(64);
const qwenGraph: NonNullable<WorkflowDefinition["template"]> = {
  loader: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors" } },
  output: { class_type: "SaveImage", inputs: { images: ["loader", 0] } },
};

function cachedWorkflow(id = sourceId): WorkflowDefinition {
  return {
    id: "library-" + encodeURIComponent(id), name: "原始工作流", family: "我的工作流", description: "",
    mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [],
    output: { kind: "image", nodeId: "output", field: "images" }, template: structuredClone(qwenGraph),
    library: { sourcePath: "E:/library", folder: "Custom-cache", runnerType: "comfyui", importStatus: "ready" },
    directory: { version: 2, canvas: "image", seriesId: "library-" + encodeURIComponent("我的工作流"), bindingKey: id, bindingStatus: "bound" },
    original: {
      id, version: "1.0.0", folder: "Custom-cache", configFile: "Custom-cache/workflow.config.json", configSha256: "original-config-hash",
      executionFile: "execution.api.json", executionStatus: "plain", executionSha256: "original-execution-hash",
      inputs: [], models: [], docsUrl: "", promptPlaceholder: "", parameterBindings: {},
    },
  };
}

describe("imported workflow cache classification", () => {
  it.each(["图像生成", "图像编辑", "视频生成", "音频生成", "图像工具", "视频工具", "通用工具"])("upgrades an old automatic %s bucket from actual model evidence", family => {
    const cached = cachedWorkflow(); cached.family = family;
    const [normalized] = withBuiltinBindings([], [cached]);
    expect(normalized.family).toBe("Qwen 图像");
    expect(normalized.original).toBe(cached.original);
    expect(cached.family).toBe(family);
  });
  it("does not downgrade an existing broad generation class when no model evidence is available", () => {
    expect(resolveWorkflowImportFamily("视频生成", sourceId, {}, { kind: "video" })).toBe("视频生成");
    expect(resolveWorkflowImportFamily("视频生成", "vendor.video", qwenGraph, { kind: "image" })).toBe("视频生成");
    expect(resolveWorkflowImportFamily("我的自定义分组", sourceId, qwenGraph, { kind: "image" })).toBe("我的自定义分组");
  });
  it("classifies a cached library graph while retaining IDs, hidden preference identity, and source snapshots", () => {
    const cached = cachedWorkflow();
    const sourceBytes = JSON.stringify(cached);
    const taskSnapshot = { workflow: cached, graph: cached.template, submissionId: cached.id };
    const taskBytes = JSON.stringify(taskSnapshot);
    Object.freeze(cached.directory);
    Object.freeze(cached);

    const [normalized] = withBuiltinBindings([], [cached]);

    expect(normalized.family).toBe("Qwen 图像");
    expect(normalized.directory?.seriesId).toBe("library-" + encodeURIComponent("Qwen 图像"));
    expect(normalized).not.toBe(cached);
    expect(normalized.id).toBe(cached.id);
    expect(normalized.original).toBe(cached.original);
    expect(normalized.template).toBe(cached.template);
    expect(normalized.library).toBe(cached.library);
    expect(workflowVisibilityKey(normalized)).toBe(workflowVisibilityKey(cached));
    expect(JSON.stringify(cached)).toBe(sourceBytes);
    expect(JSON.stringify(taskSnapshot)).toBe(taskBytes);
  });

  it("classifies a pending cached entry from retained model references when no execution graph exists", () => {
    const cached = cachedWorkflow();
    cached.template = undefined;
    cached.family = "自定义工作流";
    cached.library!.importStatus = "pending";
    cached.directory!.bindingStatus = "pending";
    cached.original!.models = [{ name: "qwen_image_2.1_bf16.safetensors", required: true }];
    const sourceBytes = JSON.stringify(cached);

    const [normalized] = withBuiltinBindings([], [cached]);

    expect(normalized.family).toBe("Qwen 图像");
    expect(normalized.template).toBeUndefined();
    expect(normalized.library?.importStatus).toBe("pending");
    expect(normalized.directory?.bindingStatus).toBe("pending");
    expect(normalized.original?.models).toBe(cached.original?.models);
    expect(JSON.stringify(cached)).toBe(sourceBytes);
  });

  it("classifies retained project imports from their own ID and leaves explicit families and vendor entries untouched", () => {
    const cached = cachedWorkflow();
    const projectImport: WorkflowDefinition = { ...cached, id: sourceId, original: undefined, library: undefined, directory: undefined, family: "" };
    const explicit = { ...projectImport, id: "custom." + "b".repeat(64), family: "我的专属系列" };
    const vendor = { ...projectImport, id: "vendor.qwen", family: "我的工作流" };
    const invalidImportId = { ...projectImport, id: "custom.named-entry", family: "自定义工作流" };
    const sourceBytes = JSON.stringify([projectImport, explicit, vendor, invalidImportId]);

    const [normalized, retainedExplicit, retainedVendor, retainedInvalid] = withBuiltinBindings([projectImport, explicit, vendor, invalidImportId]);

    expect(normalized.family).toBe("Qwen 图像");
    expect(normalized.id).toBe(projectImport.id);
    expect(normalized.template).toBe(projectImport.template);
    expect(normalized.library).toBeUndefined();
    expect(retainedExplicit).toBe(explicit);
    expect(retainedVendor).toBe(vendor);
    expect(retainedInvalid).toBe(invalidImportId);
    expect(JSON.stringify([projectImport, explicit, vendor, invalidImportId])).toBe(sourceBytes);
  });

  it("groups an old generic cache entry with the same newly classified library series", () => {
    const oldEntry = cachedWorkflow();
    const currentEntry = cachedWorkflow("custom." + "b".repeat(64));
    currentEntry.family = "Qwen 图像";
    currentEntry.directory!.seriesId = "library-" + encodeURIComponent(currentEntry.family);

    const merged = withBuiltinBindings([], [oldEntry, currentEntry]);
    const image = buildDirectoryView(merged).find(canvas => canvas.id === "image")!;

    expect(image.series).toHaveLength(1);
    expect(image.series[0]).toMatchObject({ name: "Qwen 图像", workflows: 2 });
    expect(workflowSeriesId(merged[0])).toBe(workflowSeriesId(currentEntry));
    expect(filterDirectoryWorkflows(image, workflowSeriesId(merged[0]), "QWEN")).toEqual(merged);
    expect(merged[1]).toBe(currentEntry);
  });

  it("groups a retained project import's old directory series with the current library series", () => {
    const cached = cachedWorkflow();
    const projectImport: WorkflowDefinition = { ...cached, id: sourceId, original: undefined, library: undefined };
    const currentEntry = cachedWorkflow("custom." + "b".repeat(64));
    currentEntry.family = "Qwen 图像";
    currentEntry.directory!.seriesId = "library-" + encodeURIComponent(currentEntry.family);
    const sourceBytes = JSON.stringify(projectImport);

    const merged = withBuiltinBindings([projectImport], [currentEntry]);
    const normalized = merged.find(workflow => workflow.id === projectImport.id)!;
    const image = buildDirectoryView(merged).find(canvas => canvas.id === "image")!;

    expect(normalized.family).toBe("Qwen 图像");
    expect(normalized.directory?.seriesId).toBe(currentEntry.directory?.seriesId);
    expect(normalized.directory?.bindingKey).toBe(projectImport.directory?.bindingKey);
    expect(normalized.id).toBe(projectImport.id);
    expect(image.series).toHaveLength(1);
    expect(image.series[0]).toMatchObject({ name: "Qwen 图像", workflows: 2 });
    expect(workflowSeriesId(normalized)).toBe(workflowSeriesId(currentEntry));
    expect(JSON.stringify(projectImport)).toBe(sourceBytes);
  });

  it("keeps a rescanned empty directory authoritative instead of resurrecting a saved library cache entry", () => {
    const cached = cachedWorkflow();
    const sourceBytes = JSON.stringify(cached);

    expect(withBuiltinBindings([cached], [], cached.library?.sourcePath)).toEqual([]);
    expect(JSON.stringify(cached)).toBe(sourceBytes);
  });
});
