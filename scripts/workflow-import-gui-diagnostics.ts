type Data = Record<string, any>;
const UI_ONLY = /^(?:Note|MarkdownNote|PrimitiveNode|Reroute)$/i;

/** These frontend operations require ComfyUI's graph-to-prompt semantics.
 * Do not execute a naive conversion or mistake frontend nodes for missing plugins.
 * The raw UI graph remains untouched; API exports have already resolved this state.
 */
export function guardGuiWorkflowCompilation(workflow: Data, format: string, analysis: Data): Data {
  if (!["comfy-ui-0.4", "comfy-ui-1.0"].includes(format) || !Array.isArray(workflow.nodes)) return analysis;
  const unsupported = workflow.nodes.filter((node: Data) => node && (node.mode === 2 || node.mode === 4 || UI_ONLY.test(node.type)));
  if (!unsupported.length) return analysis;
  const frontendIds = new Set(unsupported.filter((node: Data) => UI_ONLY.test(node.type)).map((node: Data) => String(node.id)));
  const warnings = (Array.isArray(analysis.warnings) ? analysis.warnings : []).filter((warning: Data) =>
    warning.code !== "MISSING_NODE_TYPE" || !frontendIds.has(String(warning.nodeId)));
  for (const node of unsupported) warnings.push({ code: "GUI_EXECUTION_SEMANTICS_UNSUPPORTED", nodeId: String(node.id), classType: node.type,
    reason: node.mode === 2 ? "muted" : node.mode === 4 ? "bypassed" : "frontend-only" });
  const { apiJson: _apiJson, draftApiJson: _draftApiJson, ...rest } = analysis;
  return { ...rest, compileStatus: "needs-api-export", warnings };
}
