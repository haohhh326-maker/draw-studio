import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeProps } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset, CanvasNode, Kind } from "../src/types";

const fixture = vi.hoisted(() => ({ asset: undefined as Asset | undefined, zoom: 1, selectedId: null as string | null }));
vi.mock("../src/stores/store", async importOriginal => {
  const original = await importOriginal<typeof import("../src/stores/store")>();
  const useStore = Object.assign((selector: (state: ReturnType<typeof original.useStore.getState>) => unknown) => {
    const state = original.useStore.getInitialState();
    return selector({ ...state, selectedId: fixture.selectedId, project: { ...state.project,
      assets: fixture.asset ? { [fixture.asset.id]: fixture.asset } : {}, tasks: {}, history: [],
    } });
  }, original.useStore);
  return { ...original, useStore };
});
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  Handle: () => null, NodeResizer: () => null,
  useStore: (selector: (state: { transform: number[]; nodeLookup: Map<string, { measured: { width: number; height: number } }> }) => unknown) =>
    selector({ transform: [0, 0, fixture.zoom], nodeLookup: new Map([["node", { measured: { width: 360, height: 360 } }]]) }),
}));
vi.mock("../src/assets/AssetPreview", async importOriginal => ({
  ...await importOriginal<typeof import("../src/assets/AssetPreview")>(),
  AssetPreview: ({ asset, full = false, previewSize = 512 }: { asset: Asset; full?: boolean; previewSize?: number }) =>
    createElement("div", { "data-preview-kind": asset.kind, "data-full": String(full), "data-preview-size": previewSize }, asset.name),
}));
import { MediaNode } from "../src/nodes/MediaNode";

function render(kind: Kind, assetKind?: Asset["kind"]) {
  fixture.asset = assetKind ? { id: "result", name: "generated-result", kind: assetKind,
    mime: "application/octet-stream", size: 10, createdAt: 1, text: "生成的正文" } : undefined;
  const props: NodeProps<CanvasNode> = {
    id: "node", type: "media", selected: false, dragging: false, draggable: true,
    selectable: true, deletable: true, isConnectable: true, zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { kind, title: "生成结果", assetId: fixture.asset?.id, text: "可编辑正文",
      generation: { workflowId: "workflow", prompt: "", negativePrompt: "", params: {}, taskId: null } },
  };
  return renderToStaticMarkup(createElement(MediaNode, props));
}
afterEach(() => { fixture.asset = undefined; fixture.zoom = 1; fixture.selectedId = null; });

describe("canvas result media presentation", () => {
  it("loads a reusable image preview at ordinary canvas scale", () => {
    const html = render("image-generation", "image");
    expect(html).toContain('data-full="false"');
    expect(html).toContain('data-preview-size="512"');
  });
  it("increases image preview resolution only across display-size thresholds", () => {
    fixture.zoom = 2;
    expect(render("image-generation", "image")).toContain('data-preview-size="1024"');
    expect(render("image-generation", "image")).toContain('data-full="false"');
    fixture.zoom = 4;
    expect(render("image-generation", "image")).toContain('data-full="false"');
    expect(render("image-generation", "image")).toContain('data-preview-size="2048"');
  });
  it("keeps the actively selected image on its bounded canvas preview", () => {
    fixture.selectedId = "node";
    expect(render("image-generation", "image")).toContain('data-full="false"');
    expect(render("image-generation", "image")).toContain('data-preview-size="512"');
  });
  it.each([
    ["image-generation", "video", "clapperboard"],
    ["video", "image", "image"],
    ["image-generation", "audio", "audio-lines"],
    ["tool", "image", "image"],
    ["image-generation", "file", "file"],
  ] as const)("shows the actual %s result as %s", (nodeKind, assetKind, icon) => {
    const html = render(nodeKind, assetKind);
    expect(html).toContain(`data-preview-kind="${assetKind}"`);
    expect(html).toContain(`lucide-${icon}`);
    expect(html).toContain(`>${assetKind.toUpperCase()}</span>`);
    expect(html).not.toMatch(/IMAGE \/ AI|VIDEO \/ AI/);
    expect(fixture.asset?.kind).toBe(assetKind);
  });

  it.each(["image", "video", "audio", "file"] as const)("does not hide a text node's actual %s result behind its text editor", kind => {
    const html = render("text", kind);
    expect(html).toContain(`data-preview-kind="${kind}"`);
    expect(html).not.toContain("<textarea");
  });

  it.each([undefined, "text"] as const)("retains the text editor with %s text output", kind => {
    const html = render("text", kind);
    expect(html).toContain('aria-label="文本内容"');
    expect(html).toContain("可编辑正文");
    expect(html).not.toContain("data-preview-kind");
  });

  it("retains the declared media placeholder before a result arrives", () => {
    expect(render("image-generation")).toContain("IMAGE / AI");
    expect(render("video")).toContain("VIDEO / AI");
    expect(render("reference")).toContain("lucide-folder-open");
  });
});
