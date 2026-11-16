import type { Connection, WorkflowDefinition } from "../types";

/** Built-in website-account operations; these are not ComfyUI graph templates. */
export const museConnection: Connection = {
  name: "Muse", baseUrl: "/api/muse", token: "", authHeader: "", authPrefix: "", timeoutMinutes: 0,
};
export const museWorkflows: WorkflowDefinition[] = (["image", "video"] as const).map(kind => ({
  id: `muse-${kind}`, muse: { kind }, family: "Muse", name: kind === "image" ? "Muse 图片" : "Muse 视频",
  description: "使用登录的 Muse 账号生成，可连接图片、视频和音频作为参考。", defaultPrompt: "", promptRequired: true,
  mode: kind === "image" ? "text-to-image" : "text-to-video", requiredInputs: [], optionalInputs: ["referenceImages", "referenceVideos", "referenceAudios"],
  parameters: [{ key: "aspectRatio", label: "比例", type: "select", default: "auto", options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"], optionLabels: { auto: "自动" } }],
  mapping: [], output: { nodeId: "muse", field: "media", kind },
}));
