type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const metadataKeys = new Set(["workflow", "extra_pnginfo", "extra_data", "metadata"]);

/** A literal node ID named "prompt" is valid in a bare API workflow. */
export function comfyArtifactRoot(source: Data): Data {
  const prompt = source.prompt;
  if (!record(prompt)) return source;
  if (typeof prompt.class_type === "string" && record(prompt.inputs)) return source;
  if (Array.isArray(prompt.nodes)) return prompt;
  const entries = comfyApiEntries(prompt);
  return entries.length && entries.every(([, node]) => record(node) && record(node.inputs)) ? prompt : source;
}

export function comfyApiEntries(graph: Data): [string, unknown][] {
  return Object.entries(graph).filter(([id, node]) => !metadataKeys.has(id) ||
    (record(node) && (Object.hasOwn(node, "class_type") || Object.hasOwn(node, "inputs"))));
}
