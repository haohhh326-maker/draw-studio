import { describe, expect, it } from "vitest";
import { guardGuiWorkflowCompilation } from "../scripts/workflow-import-gui-diagnostics";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";

describe("GUI execution semantics diagnostics", () => {
  it.each([2, 4])("does not execute a named-widget conversion that ignores mode %s", async mode => {
    const source = { version: 0.4, nodes: [{ id: 1, type: "TestNode", mode, widgets_values: { value: 1 } }], links: [] };
    const before = structuredClone(source);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source,
      objectInfo: { TestNode: { input: { required: { value: ["INT"] } }, output: ["INT"], output_node: true } } });
    expect(result.workflow).toBeNull();
    expect(result.analysis.compileStatus).toBe("needs-api-export");
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "GUI_EXECUTION_SEMANTICS_UNSUPPORTED", reason: mode === 2 ? "muted" : "bypassed" }));
    expect(source).toEqual(before);
  });
  it.each(["Note", "MarkdownNote", "PrimitiveNode", "Reroute"])("does not recommend installing frontend-only %s as a server plugin", type => {
    const source = { nodes: [{ id: 1, type }] };
    const analysis = { compileStatus: "needs-api-export", warnings: [{ code: "MISSING_NODE_TYPE", nodeId: "1", classType: type }, { code: "MISSING_NODE_TYPE", nodeId: "2", classType: "RealMissingPlugin" }] };
    const before = structuredClone({ source, analysis });
    const result = guardGuiWorkflowCompilation(source, "comfy-ui-1.0", analysis);
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "MISSING_NODE_TYPE", nodeId: "1" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "MISSING_NODE_TYPE", nodeId: "2" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "GUI_EXECUTION_SEMANTICS_UNSUPPORTED", nodeId: "1" }));
    expect({ source, analysis }).toEqual(before);
  });
  it("leaves normal GUI compilation, unknown versions and all API behavior unchanged", () => {
    const analysis = { compileStatus: "ready", apiJson: { original: true }, warnings: [] };
    expect(guardGuiWorkflowCompilation({ nodes: [{ id: 1, type: "TestNode", mode: 0 }] }, "comfy-ui-0.4", analysis)).toBe(analysis);
    expect(guardGuiWorkflowCompilation({ nodes: [{ id: 1, type: "Reroute", mode: 4 }] }, "comfy-api", analysis)).toBe(analysis);
    expect(guardGuiWorkflowCompilation({ nodes: [{ id: 1, type: "Reroute" }] }, "comfy-ui-unknown", analysis)).toBe(analysis);
  });
});
