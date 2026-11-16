import type { ApiWorkflow, Asset, RemoteFile, WorkflowDefinition } from "../types";

type OutputDescriptor = WorkflowDefinition["output"];
type DownloadedOutput = { file: RemoteFile; asset: Asset };

// Model, conditioning and control links do not establish that two published
// images descend from the same image. In particular, sharing a checkpoint is
// not evidence that one independent result is an upscale of the other.
const nonMediaInput = /^(?:model|upscale_model|clip|vae|positive|negative|conditioning|control_net|guider|sigmas|sampler|scheduler|noise|seed)$/i;

function mediaParents(graph: ApiWorkflow, id: string): string[] {
  const node = graph[id];
  if (!node) return [];
  const parents = new Set<string>(), visited = new WeakSet<object>();
  const scan = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value) && value.length === 2 &&
      (typeof value[0] === "string" || typeof value[0] === "number") &&
      Number.isInteger(value[1]) && value[1] >= 0 && graph[String(value[0])]) {
      parents.add(String(value[0]));
      return;
    }
    for (const child of Object.values(value)) scan(child);
  };
  for (const [field, value] of Object.entries(node.inputs)) if (!nonMediaInput.test(field)) scan(value);
  return [...parents];
}

function mediaAncestors(graph: ApiWorkflow, id: string): Set<string> {
  const result = new Set<string>(), pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    if (result.has(current) || !graph[current]) continue;
    result.add(current);
    pending.push(...mediaParents(graph, current));
  }
  return result;
}

function isUpscaleOperation(graph: ApiWorkflow, id: string): boolean {
  const node = graph[id];
  if (!node || /loader|load_model/i.test(node.class_type)) return false;
  const factor = ["scale_by", "upscale_by", "scale_factor", "upscale_factor"].map(key => node.inputs[key])
    .find((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (factor !== undefined) return factor > 1 && /upscale|scale|resize/i.test(node.class_type);
  return /upscale|esrgan|super.?resolution|supir|flashvsr/i.test(node.class_type);
}

/** Strong graph evidence only: an actual upscale on the same media lineage. */
function expandsSameSource(graph: ApiWorkflow | undefined, candidateId: string, otherId: string): boolean {
  if (!graph || candidateId === otherId || !graph[candidateId] || !graph[otherId]) return false;
  const candidate = mediaAncestors(graph, candidateId), other = mediaAncestors(graph, otherId);
  // The actual media wired into the other publisher must feed this upscale.
  // A distant common input (e.g. an empty latent or reference photograph) is
  // insufficient: two independent samplers may legitimately share that input.
  const publishedSource = new Set([otherId, ...mediaParents(graph, otherId)]);
  for (const id of candidate) {
    if (other.has(id) || !isUpscaleOperation(graph, id)) continue;
    if ([...mediaAncestors(graph, id)].some(parent => parent !== id && publishedSource.has(parent))) return true;
  }
  return false;
}

/** Negative means a is preferred. Names, numeric node IDs and URL order are not quality evidence. */
export function compareOutputDescriptors(workflow: WorkflowDefinition, a: OutputDescriptor, b: OutputDescriptor): number {
  if (a.kind !== b.kind || !["image", "video"].includes(a.kind)) return 0;
  const aExpanded = expandsSameSource(workflow.template, a.nodeId, b.nodeId);
  const bExpanded = expandsSameSource(workflow.template, b.nodeId, a.nodeId);
  return aExpanded === bExpanded ? 0 : aExpanded ? -1 : 1;
}

/** Pick a same-kind default branch, while explicit branch selection remains the caller's responsibility. */
export function selectPreferredOutputDescriptor(
  workflow: WorkflowDefinition,
  choices: readonly OutputDescriptor[] = [workflow.output, ...(workflow.additionalOutputs ?? [])],
): OutputDescriptor {
  const sameKind = choices.filter(output => output.kind === workflow.output.kind);
  let selected = sameKind.find(output => output.nodeId === workflow.output.nodeId && output.field === workflow.output.field)
    ?? sameKind[0] ?? workflow.output;
  for (const output of sameKind) if (compareOutputDescriptors(workflow, output, selected) < 0) selected = output;
  return selected;
}

function pixelArea(asset: Asset, file?: RemoteFile): number | undefined {
  const width = asset.width ?? file?.width, height = asset.height ?? file?.height;
  return typeof width === "number" && Number.isFinite(width) && width > 0 &&
    typeof height === "number" && Number.isFinite(height) && height > 0 ? width * height : undefined;
}

/**
 * Retain every legitimate result. Real decoded size wins within one media kind;
 * graph evidence breaks unknown/equal-size ties. Mixed-kind contract order is
 * preserved, except that an explicitly declared primary kind stays primary.
 */
export function prioritizeOutputAssets(
  workflow: WorkflowDefinition,
  assets: readonly Asset[],
  downloadedOutputs: readonly DownloadedOutput[],
): Asset[] {
  const receipts = new Map(downloadedOutputs.map(output => [output.asset.id, output.file]));
  const groups = new Map<Asset["kind"], { asset: Asset; index: number }[]>();
  assets.forEach((asset, index) => {
    const group = groups.get(asset.kind) ?? [];
    group.push({ asset, index }); groups.set(asset.kind, group);
  });
  for (const [kind, group] of groups) {
    if (kind !== "image" && kind !== "video") continue;
    const compare = (a: typeof group[number], b: typeof group[number]) => {
      const aFile = receipts.get(a.asset.id), bFile = receipts.get(b.asset.id);
      const aPixels = pixelArea(a.asset, aFile), bPixels = pixelArea(b.asset, bFile);
      if (aPixels !== undefined && bPixels !== undefined && aPixels !== bPixels) return bPixels - aPixels;
      if (aFile?.sourceNodeId && bFile?.sourceNodeId) {
        const order = compareOutputDescriptors(workflow,
          { nodeId: aFile.sourceNodeId, field: aFile.sourceField ?? "*", kind },
          { nodeId: bFile.sourceNodeId, field: bFile.sourceField ?? "*", kind });
        if (order) return order;
      }
      return 0;
    };
    // Missing metadata is not a quality score. A normal Array.sort comparator
    // that falls back to original indices can let an unknown-size result hide
    // a later known HD result without ever comparing it to the normal image.
    // Select by positive evidence, retaining receipt order when none exists.
    const remaining = [...group], ordered: typeof group = [];
    while (remaining.length) {
      let best = 0;
      for (let i = 1; i < remaining.length; i++) if (compare(remaining[i], remaining[best]) < 0) best = i;
      ordered.push(remaining.splice(best, 1)[0]);
    }
    groups.set(kind, ordered);
  }
  const offsets = new Map<Asset["kind"], number>();
  const ordered = assets.map(asset => {
    const offset = offsets.get(asset.kind) ?? 0;
    offsets.set(asset.kind, offset + 1);
    return groups.get(asset.kind)![offset].asset;
  });
  if (workflow.output.kind === "file") return ordered;
  return [...ordered.filter(asset => asset.kind === workflow.output.kind), ...ordered.filter(asset => asset.kind !== workflow.output.kind)];
}
