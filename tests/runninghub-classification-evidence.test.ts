import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { runningHubWorkflowCategory } from "../src/runninghub/classification";
import { runningHubAppFromRead } from "../src/runninghub/client";
import { analyzeRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { applyRunningHubWorkflowMetadata, runningHubWorkflowClassification } from "../src/runninghub/workflow-metadata";
import { prepareRunningHubApp } from "../src/runninghub/workflows";
import { categoryForWorkflow, workflowSeriesName } from "../src/workflow/directory-view";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";

// Exact public schema/tag evidence from /api/webapp/detail, without media URLs or credentials.
const upscaleApp = {
  appName: "高清放大",
  tags: [{ id: "1871151815242543200", name: "文生视频", nameEn: "Text-to-Video", labels: null }],
  nodeInfoList: [{ nodeId: "69", fieldName: "image", nodeName: "LoadImage", fieldType: "IMAGE",
    fieldData: '[["example.png", "None", "example.png", "keep_this_dic"], {"image_upload": true}]' }],
};
const upstreamSource = { repository: "https://github.com/Work-Fisher/AIFISHER", revision: "bdcf3bec054594fcab591952a8c5acef858d6de4" };
const outputNode = "fisherai_webapp_output";

async function readApp(source = upscaleApp, id = "2097920992202022914") {
  const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: id, source });
  const app = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
  const reader = read as unknown as RunningHubReaderResult;
  return { app, reader, options: { workflowId: id, baseUrl: "https://www.runninghub.cn", name: source.appName, reader } };
}

describe("RunningHub classification uses only output evidence", () => {
  it("keeps AIFISHER's actual video-tag inference but leaves the upscale output type unconfirmed", async () => {
    const { app, reader } = await readApp();
    expect(app.rawInfo?.tags).toEqual(upscaleApp.tags);
    expect(reader.category).toBe("video");
    expect(reader.projection?.snapshot.categoryId).toBe("video");
    expect(reader.upstream).toEqual(upstreamSource);
    const before = structuredClone(reader);
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.inputs).toEqual([expect.objectContaining({ nodeId: "69", field: "image", kind: "image" })]);
    expect(analysis.outputs).toEqual([expect.objectContaining({ nodeId: outputNode, field: "*", kind: "file" })]);
    expect(reader).toEqual(before);
  });

  it("places the user's confirmed image output in image tools despite the misleading platform video tag", async () => {
    const { app, reader, options } = await readApp();
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { ...options,
      outputs: [{ nodeId: outputNode, field: "*", kind: "image" }],
    });
    const refreshed = applyRunningHubWorkflowMetadata(workflow, {
      name: upscaleApp.appName, platformCategory: "video", platformCategoryReader: upstreamSource,
    });
    expect(refreshed.importReader?.category).toBe("video");
    expect(refreshed.runninghub?.platformCategory).toBe("video");
    expect(runningHubWorkflowCategory(refreshed)).toBe("image");
    expect(categoryForWorkflow(refreshed)).toBe("image");
    expect(workflowSeriesName(refreshed)).toBe("图像工具");
    expect(runningHubWorkflowClassification(refreshed)).toEqual({ family: "图像工具", label: "图像" });
    expect(refreshed.output).toEqual({ nodeId: outputNode, field: "*", kind: "image" });
    expect(refreshed.template).toEqual(reader.workflow);
    expect(refreshed.mapping).toEqual(workflow.mapping);
    expect(refreshed.runninghub?.bindingMode).toBe("selected");
  });

  it("keeps the confirmed output and category after repeated public metadata refreshes", async () => {
    const { app, reader, options } = await readApp();
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { ...options,
      outputs: [{ nodeId: outputNode, field: "files", kind: "image" }],
    });
    let refreshed = workflow;
    for (let index = 0; index < 2; index += 1) refreshed = applyRunningHubWorkflowMetadata(refreshed, {
      name: upscaleApp.appName, platformCategory: "video", platformCategoryReader: upstreamSource,
      coverUrl: "https://cdn.runninghub.cn/covers/upscale.png", coverMediaType: "image",
    });
    expect(refreshed.output).toEqual(workflow.output);
    expect(refreshed.template).toEqual(workflow.template);
    expect(refreshed.mapping).toEqual(workflow.mapping);
    expect(refreshed.mode).toBe(workflow.mode);
    expect(runningHubWorkflowCategory(refreshed)).toBe("image");
    expect(categoryForWorkflow(refreshed)).toBe("image");
    expect(runningHubWorkflowClassification(refreshed)).toEqual({ family: "图像工具", label: "图像" });
  });

  it("keeps the previous MiniMax app pending until its output is typed despite video tags", async () => {
    const source = { appName: "MiniMax H3_电影质感V2", tags: [
      { id: "1871151815242543200", name: "文生视频", nameEn: "Text-to-Video", labels: null },
    ], nodeInfoList: [
      { nodeId: "199", fieldName: "image", nodeName: "LoadImage", fieldType: "IMAGE", fieldData: '[[], {"image_upload":true}]' },
    ] };
    const { app, reader, options } = await readApp(source, "2092444522851684354");
    const { workflow } = prepareRunningHubApp({ ...app, reader }, options);
    expect(reader.category).toBe("video");
    expect(workflow.output).toMatchObject({ nodeId: outputNode, field: "*", kind: "file" });
    expect(runningHubWorkflowCategory(workflow)).toBeUndefined();
    expect(categoryForWorkflow(workflow)).toBe("pending");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "待确认输出", label: "待确认" });
  });

  it("does not let a preview image hide a confirmed video among multiple outputs", async () => {
    const { app, reader, options } = await readApp();
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { ...options,
      outputs: [{ nodeId: outputNode, field: "files", kind: "image" }],
    });
    workflow.additionalOutputs = [{ nodeId: outputNode, field: "videos", kind: "video" }];
    workflow.runninghub!.platformCategory = "image";
    expect(runningHubWorkflowCategory(workflow)).toBe("video");
    expect(categoryForWorkflow(workflow)).toBe("video");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "视频工具", label: "视频" });
  });

  it.each([
    ["image", "image", "图像工具", "图像"],
    ["video", "video", "视频工具", "视频"],
    ["audio", "music", "音频工具", "音频"],
  ] as const)("uses the app's explicit %s output declaration without changing its upstream projection", async (outputType, category, family, label) => {
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "2097920992202022914", source: upscaleApp });
    const app = { ...runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult), outputKind: outputType };
    const reader = read as unknown as RunningHubReaderResult;
    const before = structuredClone(reader);
    expect(app.outputKind).toBe(outputType);
    expect(reader.category).toBe("video");
    expect(analyzeRunningHubUpstream(reader, app.outputKind).outputs).toEqual([
      expect.objectContaining({ nodeId: outputNode, field: "files", kind: outputType }),
    ]);
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: "2097920992202022914", baseUrl: "https://www.runninghub.cn", name: upscaleApp.appName, reader,
    });
    expect(workflow.output).toEqual({ nodeId: outputNode, field: "files", kind: outputType });
    expect(categoryForWorkflow(workflow)).toBe(category);
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family, label });
    expect(workflow.template).toEqual(reader.workflow);
    expect(reader).toEqual(before);
  });

  it("retains an explicitly confirmed image output over a conflicting app declaration", async () => {
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "2097920992202022914", source: upscaleApp });
    const app = { ...runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult), outputKind: "video" as const };
    const reader = read as unknown as RunningHubReaderResult;
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: "2097920992202022914", baseUrl: "https://www.runninghub.cn", name: upscaleApp.appName, reader,
      outputs: [{ nodeId: outputNode, field: "files", kind: "image" }],
    });
    expect(app.outputKind).toBe("video");
    expect(workflow.output).toEqual({ nodeId: outputNode, field: "files", kind: "image" });
    expect(categoryForWorkflow(workflow)).toBe("image");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "图像工具", label: "图像" });
    expect(workflow.template).toEqual(reader.workflow);
  });
});
