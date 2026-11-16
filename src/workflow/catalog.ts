import type { WorkflowDefinition } from "../types";
import { directoryCatalog } from "./dfcine-directory";
import { resolveWorkflowImportFamily } from "./import-category";
import { cleanWorkflowCredentials } from "./credentials";

export const catalog = directoryCatalog;
const recoveredSourceIds: Record<string, string> = {
  "dfcine-v2-video-video-upscale-flashvsr": "flashvsr-video-upscale",
};
function originalIdFor(id: string) {
  return catalog.find(w => w.id === id)?.original?.id ?? recoveredSourceIds[id];
}
/** Old node references can resolve aliases without duplicating directory entries. */
export function findWorkflow(workflows: WorkflowDefinition[], id: string) {
  return workflows.find(w => w.id === id) ?? workflows.find(w => w.library && w.original &&
    (w.original.id === originalIdFor(id) || "library-" + encodeURIComponent(w.original.id) === id));
}

function withImportedFamily(workflow: WorkflowDefinition): WorkflowDefinition {
  const family = resolveWorkflowImportFamily(workflow.family, workflow.original?.id ?? workflow.id, workflow.template,
    { name: workflow.name, kind: workflow.output.kind, models: workflow.original?.models });
  if (family === workflow.family) return workflow;
  return { ...workflow, family, ...(workflow.directory
    ? { directory: { ...workflow.directory, seriesId: "library-" + encodeURIComponent(family) } } : {}) };
}

// Keep stable IDs for existing canvas nodes. Source identity comes from the
// manifest, never from a similar display name. Tasks retain their own snapshots.
export function withBuiltinBindings(saved: WorkflowDefinition[], library: WorkflowDefinition[] = [], sourcePath = library[0]?.library?.sourcePath) {
  const classifiedLibrary = library.map(withImportedFamily);
  const byOriginal = new Map(classifiedLibrary.filter(w => w.original).map(w => [w.original!.id, w]));
  // This earlier placeholder had no original file. Its source ID has now been
  // verified from FlashVSR-VideoUpscale/workflow.config.json in the selected library.
  const consumed = new Set<string>();
  const result: WorkflowDefinition[] = catalog.flatMap(builtin => {
    const originalId = builtin.original?.id ?? recoveredSourceIds[builtin.id];
    const loaded = originalId ? byOriginal.get(originalId) : undefined;
    // A successful directory scan (including an empty directory) owns the menu.
    // Built-ins only translate IDs used by old canvas nodes, never add entries.
    if (!loaded) return [];
    if (consumed.has(loaded.id)) return [];
    consumed.add(loaded.id);
    return [{ ...loaded, id: builtin.id }];
  });
  const ids = new Set(result.map(w => w.id));
  for (const workflow of classifiedLibrary) {
    if (ids.has(workflow.id) || consumed.has(workflow.id) || workflow.id.startsWith("mirror-")) continue;
    result.push(workflow);
    ids.add(workflow.id);
  }
  for (const workflow of saved) {
    if (ids.has(workflow.id) || consumed.has(workflow.id) || workflow.id.startsWith("mirror-")) continue;
    if (workflow.library || catalog.some(b => b.id === workflow.id)) continue;
    result.push(withImportedFamily(workflow));
    ids.add(workflow.id);
  }
  // Catalog normalization does not mutate entries. Keep clean definitions by
  // identity so a library refresh does not invalidate active node references.
  return result.map(workflow => cleanWorkflowCredentials(workflow, { preserveIdentity: true }));
}
export function compactWorkflows(workflows: WorkflowDefinition[]) {
  return workflows.map((w) =>
    !w.library && w.directory && catalog.some((b) => b.id === w.id)
      ? { ...w, template: undefined, parameters: [], mapping: [], outputChoices: undefined, original: undefined }
      : w,
  );
}
export const defaultConnection = {
  name: "AutoDL 工作站", baseUrl: import.meta.env.VITE_CANVAS_CLOUD === "true" && typeof window !== "undefined"
    ? new URL(import.meta.env.BASE_URL + "comfy", window.location.origin).toString()
    : "", token: "",
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60,
};
export function parseApiWorkflow(raw: unknown) {
  const obj = raw as Record<string, unknown>;
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || "nodes" in obj)
    throw new Error("请导入 API 格式工作流，而非编辑器格式。");
  const candidate = ("prompt" in obj ? obj.prompt : obj) as WorkflowDefinition["template"];
  if (!candidate || !Object.keys(candidate).length) throw new Error("工作流为空。");
  for (const [id, n] of Object.entries(candidate))
    if (!n || typeof n.class_type !== "string" || !n.inputs || typeof n.inputs !== "object" || Array.isArray(n.inputs))
      throw new Error("无效的 API 节点：" + id);
  return candidate!;
}
export function defaults(w: WorkflowDefinition) {
  return Object.fromEntries(w.parameters.map((p) => [p.key, p.default]));
}
