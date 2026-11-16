import { expect, it } from "vitest";
import { resolvePrompt } from "../src/semantic/prompt";
import type { Canvas } from "../src/types";
it("orders connected text by edge order and appends the local prompt", () => {
  const canvas: Canvas = {
    id: "c",
    name: "c",
    sceneId: "s",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "a",
        position: { x: 0, y: 0 },
        data: { kind: "text", title: "A", text: "  第一段  " },
      },
      {
        id: "b",
        position: { x: 0, y: 0 },
        data: { kind: "text", title: "B", text: "第二段" },
      },
    ],
    edges: [
      {
        id: "b-edge",
        source: "b",
        target: "target",
        data: { role: "auto", order: 20 },
      },
      {
        id: "a-edge",
        source: "a",
        target: "target",
        data: { role: "prompt", order: 10 },
      },
    ],
  };
  const result = resolvePrompt(canvas, "target", "补充镜头");
  expect(result.prompt).toBe("第一段\n\n第二段\n\n补充镜头");
  expect(result.texts.map((t) => t.nodeId)).toEqual(["a", "b"]);
  expect(
    resolvePrompt({ ...canvas, edges: [] }, "target", "直接输入").prompt,
  ).toBe("直接输入");
  canvas.nodes[0].data.kind = "tool";
  expect(resolvePrompt(canvas, "target", "").texts[0].text).toBe("  第一段  ");
});
