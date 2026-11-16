import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../src/types";
import { applyWorkflowCredentials, cleanWorkflowCredentials, credentialParameterValues, detectWorkflowCredentials, isWorkflowCredentialFieldName, missingWorkflowCredentials, redactWorkflowCredentialText } from "../src/workflow/credentials";

function workflow(patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id: "credential-example", name: "联网模型", description: "", family: "Test", mode: "text-to-image", requiredInputs: [], optionalInputs: [],
    parameters: [], mapping: [], output: { nodeId: "2", field: "images", kind: "image" },
    template: { "1": { class_type: "ProviderGenerate", _meta: { title: "生成模型" }, inputs: { api_key: "author-example", prompt: "完整保留示例提示词", seed: 12 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } }, ...patch };
}

describe("workflow credential detection", () => {
  it.each(["api_key", "apiKey", "OPENAI_API_KEY", "access_token", "accessToken", "auth_token", "authorization", "Authorization", "bearer_token", "secret_key", "clientSecret", "API 密钥", "认证令牌"])("recognizes real credential field %s", field => {
    expect(isWorkflowCredentialFieldName(field)).toBe(true);
  });
  it.each(["token_count", "max_tokens", "tokenizer", "keyframe", "keyframes", "keyframe_interval", "model_key", "sampling_token", "lora_key", "token", "key", "auth_method", "api_key_description", "api_key_url"])("does not mistake ordinary field %s for a credential", field => {
    expect(isWorkflowCredentialFieldName(field)).toBe(false);
  });
  it("finds and labels actual scalar ports without needing a parameter mapping", () => {
    expect(detectWorkflowCredentials(workflow())).toEqual([{ id: "1:api_key", nodeId: "1", field: "api_key", label: "api_key", required: true }]);
  });
  it("uses explicit secret schema metadata even when the port has a generic name", () => {
    const definition = workflow({ parameters: [{ key: "providerCredential", label: "服务密钥", type: "text", default: "secret-example", secret: true }], mapping: [{ semantic: "providerCredential", nodeId: "1", field: "auth" }] });
    definition.template!["1"].inputs = { auth: "secret-example", prompt: "保留" };
    expect(detectWorkflowCredentials(definition)).toEqual([{ id: "1:auth", nodeId: "1", field: "auth", label: "服务密钥", required: true, parameterKey: "providerCredential" }]);
  });
  it("keeps optional declarations and deduplicates the same mapped input", () => {
    const definition = workflow({ parameters: [{ key: "account", label: "账号密钥", type: "text", default: "", secret: true, required: false }], mapping: [{ semantic: "account", nodeId: "1", field: "api_key" }] });
    expect(detectWorkflowCredentials(definition)).toEqual([{ id: "1:api_key", nodeId: "1", field: "api_key", label: "账号密钥", required: false, parameterKey: "account" }]);
    expect(missingWorkflowCredentials(definition, {})).toEqual([]);
  });
  it("does not overwrite a connection into a credential port", () => {
    const definition = workflow(); definition.template!["1"].inputs.api_key = ["helper", 0];
    expect(detectWorkflowCredentials(definition)).toEqual([]);
    expect(cleanWorkflowCredentials(definition).template!["1"].inputs.api_key).toEqual(["helper", 0]);
  });
  it("detects the actual string source of a credential wire while preserving the connection", () => {
    const definition = workflow({ parameters: [{ key: "sourceString", label: "value", type: "text", default: "author-example" }], mapping: [{ semantic: "sourceString", nodeId: "helper", field: "value" }] });
    definition.template!["1"].inputs.api_key = ["helper", 0];
    definition.template!.helper = { class_type: "PrimitiveString", inputs: { value: "author-example" } };
    expect(detectWorkflowCredentials(definition)).toEqual([{ id: "helper:value", nodeId: "helper", field: "value", label: "api_key", required: true, parameterKey: "sourceString" }]);
    const clean = cleanWorkflowCredentials(definition);
    expect(clean.template!.helper.inputs.value).toBe("");
    expect(clean.parameters[0]).toMatchObject({ default: "", secret: true });
    const applied = applyWorkflowCredentials(clean, { "helper:value": "own-key" });
    expect(applied.template!.helper.inputs.value).toBe("own-key");
    expect(applied.template!["1"].inputs.api_key).toEqual(["helper", 0]);
  });
  it("leaves numeric fields and entire nodes untouched", () => {
    const definition = workflow(); definition.template!["1"].inputs = { api_key: 100, access_token: false, model: "secret-key-v2.gguf", keyframe: 1 };
    expect(detectWorkflowCredentials(definition)).toEqual([]);
  });
  it("retains the original ID and explicit metadata across cleaning", () => {
    const definition = workflow({ credentials: [{ id: "remote-field-id", nodeId: "1", field: "api_key", label: "个人服务密钥", required: false }] });
    const first = cleanWorkflowCredentials(definition), second = cleanWorkflowCredentials(first, { preserveIdentity: true });
    expect(second).toEqual(first);
    expect(second).toBe(first);
    expect(second.credentials).toEqual([{ id: "remote-field-id", nodeId: "1", field: "api_key", label: "个人服务密钥", required: false }]);
  });
  it("preserves clean workflow identity only on explicit opt-in while keeping execution copies separate", () => {
    const definition = workflow({ template: { "1": { class_type: "ProviderGenerate", inputs: { prompt: "原始提示词", seed: 12 } } } });
    expect(cleanWorkflowCredentials(definition)).not.toBe(definition);
    expect(cleanWorkflowCredentials(definition, { preserveIdentity: true })).toBe(definition);
    const execution = applyWorkflowCredentials(definition, {});
    expect(execution).not.toBe(definition);
    expect(execution.template).not.toBe(definition.template);
    expect(definition.template!["1"].inputs.prompt).toBe("原始提示词");
  });
});

describe("workflow credential separation", () => {
  it("strips example keys from graph and parameter defaults while preserving normal prompts and parameters", () => {
    const definition = workflow({ defaultPrompt: "默认提示词保持不变", parameters: [
      { key: "secret", label: "API Key", type: "text", default: "author-example" },
      { key: "steps", label: "步数", type: "number", default: 28 },
    ], mapping: [{ semantic: "secret", nodeId: "1", field: "api_key" }] });
    const original = structuredClone(definition), clean = cleanWorkflowCredentials(definition);
    expect(clean.template!["1"].inputs.api_key).toBe("");
    expect(clean.parameters[0]).toMatchObject({ default: "", secret: true });
    expect(clean.template!["1"].inputs.prompt).toBe("完整保留示例提示词");
    expect(clean.defaultPrompt).toBe("默认提示词保持不变");
    expect(clean.parameters[1]).toEqual(original.parameters[1]);
    expect(clean.mapping).toEqual(original.mapping);
    expect(definition).toEqual(original);
    expect(JSON.stringify(clean)).not.toContain("author-example");
  });
  it("clears explicit secret parameter values and secret choice metadata", () => {
    const definition = workflow({ parameters: [{ key: "credential", label: "凭据", type: "select", default: "sample", secret: true, options: ["sample"], optionLabels: { sample: "sample" }, optionValues: { sample: "sample" } }] });
    const clean = cleanWorkflowCredentials(definition);
    expect(clean.parameters[0]).toMatchObject({ default: "", options: [], optionLabels: {}, optionValues: {}, secret: true });
  });
  it("clears credential examples appended to proven secret bindings without modifying target paths or unrelated defaults", () => {
    const definition = workflow({ parameters: [{ key: "providerKey", label: "Key", type: "text", default: "author-example", secret: true }], mapping: [{ semantic: "providerKey", nodeId: "1", field: "api_key" }] });
    definition.original = { id: "source", version: "1", folder: "source", configFile: "source/workflow.config.json", configSha256: "hash", executionFile: "execution.api.json", executionStatus: "plain", executionSha256: "hash", models: [], docsUrl: "", promptPlaceholder: "",
      parameterBindings: { providerKey: { target: "comfyui", nodeId: "1", path: "inputs.api_key", defaultValue: "author-example", value: "author-example" }, seed: { target: "comfyui", nodeId: "1", path: "inputs.seed", defaultValue: 12 } },
      inputs: [{ id: "key", name: "API Key", dataType: "string", binding: { target: "comfyui", nodeId: "1", path: "inputs.api_key", fieldValue: "author-example" } }],
    };
    const clean = cleanWorkflowCredentials(definition);
    expect(clean.original!.parameterBindings.providerKey).toEqual({ target: "comfyui", nodeId: "1", path: "inputs.api_key", defaultValue: "", value: "" });
    expect(clean.original!.parameterBindings.seed).toEqual(definition.original.parameterBindings.seed);
    expect(clean.original!.inputs[0].binding).toEqual({ target: "comfyui", nodeId: "1", path: "inputs.api_key", fieldValue: "" });
    expect(JSON.stringify(clean)).not.toContain("author-example");
    expect(JSON.stringify(definition.original)).toContain("author-example");
  });
  it("inserts local keys into a temporary graph and corresponding runtime parameter only", () => {
    const definition = cleanWorkflowCredentials(workflow({ parameters: [{ key: "accountKey", label: "账号密钥", type: "text", default: "", secret: true }], mapping: [{ semantic: "accountKey", nodeId: "1", field: "api_key" }] }));
    const original = structuredClone(definition), values = { "1:api_key": " local-value " };
    const applied = applyWorkflowCredentials(definition, values);
    expect(applied.template!["1"].inputs.api_key).toBe("local-value");
    expect(applied.parameters[0].default).toBe("local-value");
    expect(credentialParameterValues(definition, values)).toEqual({ accountKey: "local-value" });
    expect(definition).toEqual(original);
    expect(values["1:api_key"]).toBe(" local-value ");
    expect(applied.template!["2"].inputs.images).toEqual(["1", 0]);
  });
  it("does not reuse author defaults when the user has no saved key", () => {
    const definition = workflow();
    expect(missingWorkflowCredentials(definition, {}).map(field => field.id)).toEqual(["1:api_key"]);
    expect(missingWorkflowCredentials(definition, { "1:api_key": "   " })).toHaveLength(1);
    expect(missingWorkflowCredentials(definition, { "1:api_key": "own-key" })).toHaveLength(0);
    expect(applyWorkflowCredentials(definition, {}).template!["1"].inputs.api_key).toBe("");
  });
  it("redacts raw, encoded and escaped values without changing ordinary error context", () => {
    const values = { first: "test key/+?", second: "longer-test-key" };
    const message = "request test key/+? or " + encodeURIComponent(values.first) + " and longer-test-key failed at node 17";
    expect(redactWorkflowCredentialText(message, values)).toBe("request [已隐藏密钥] or [已隐藏密钥] and [已隐藏密钥] failed at node 17");
    expect(redactWorkflowCredentialText("Node 17 failed", { first: "" })).toBe("Node 17 failed");
  });
  it("handles RunningHub definitions with the same graph contract", () => {
    const definition = workflow({ id: "runninghub.cn.123", runninghub: { workflowId: "123", baseUrl: "https://www.runninghub.cn" } });
    expect(detectWorkflowCredentials(definition)).toHaveLength(1);
    expect(cleanWorkflowCredentials(definition).runninghub).toEqual(definition.runninghub);
    expect(applyWorkflowCredentials(definition, { "1:api_key": "rh-inner-node-value" }).template!["1"].inputs.api_key).toBe("rh-inner-node-value");
  });
});
