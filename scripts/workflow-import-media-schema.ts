type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const mediaField = /^(?:(?:image|mask|audio|video)(?:_path|_file|_filename)?|file|filename|path|file_path)$/i;
const mediaLoader = /load.*(?:image|mask|audio|video)/i;

function mediaEnum(classType: string, field: string, specification: unknown): unknown[] | undefined {
  if (!Array.isArray(specification)) return;
  const options = record(specification[1]) ? specification[1] : {};
  const values = Array.isArray(specification[0]) ? specification[0]
    : String(specification[0]).toUpperCase() === "COMBO" && Array.isArray(options.options) ? options.options : undefined;
  if (!values) return;
  const upload = ["image_upload", "mask_upload", "audio_upload", "video_upload"].some(key => options[key] === true);
  if (upload || mediaLoader.test(classType + " " + field) && mediaField.test(field)) return values;
}

/** Accept source media names as placeholders without changing runtime port types. */
export function workflowImportMediaSchema(workflow: unknown, format: string, objectInfo?: Data): Data | undefined {
  if (!objectInfo || !record(workflow)) return objectInfo;
  const fields: { classType: string; field: string; value: unknown }[] = [];
  if (format === "comfy-api") {
    for (const node of Object.values(workflow)) {
      if (!record(node) || typeof node.class_type !== "string" || !record(node.inputs)) continue;
      for (const [field, value] of Object.entries(node.inputs)) {
        if (!Array.isArray(value)) fields.push({ classType: node.class_type, field, value });
      }
    }
  } else if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      if (!record(node) || typeof node.type !== "string") continue;
      const connected = new Set<string>();
      if (Array.isArray(node.inputs)) for (const port of node.inputs) {
        if (record(port) && typeof port.name === "string" && port.link !== null && port.link !== undefined)
          connected.add(port.name);
      }
      // Positional widgets still require the upstream mapping confirmation.
      if (record(node.widgets_values)) for (const [field, value] of Object.entries(node.widgets_values))
        if (!connected.has(field)) fields.push({ classType: node.type, field, value });
    }
  }
  let result = objectInfo;
  for (const { classType, field, value } of fields) {
    if (typeof value !== "string") continue;
    const definition = objectInfo[classType];
    if (!record(definition) || !record(definition.input)) continue;
    for (const section of ["required", "optional"] as const) {
      const inputs = definition.input[section];
      if (!record(inputs)) continue;
      const specification = inputs[field];
      const values = mediaEnum(classType, field, specification);
      if (!values || values.some(option => Object.is(option, value))) continue;
      if (result === objectInfo) result = structuredClone(objectInfo);
      const copiedDefinition = result[classType] as Data;
      const copiedInputs = (copiedDefinition.input as Data)[section] as Data;
      const copiedSpecification = copiedInputs[field] as unknown[];
      const copiedValues = Array.isArray(copiedSpecification[0]) ? copiedSpecification[0]
        : (copiedSpecification[1] as Data).options as unknown[];
      if (!copiedValues.some(option => Object.is(option, value))) copiedValues.push(value);
    }
  }
  return result;
}
