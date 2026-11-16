import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIClient, ExecutionError, friendlyError } from "../src/comfyui/client";
import { clearCommunicationLog, communicationSnapshot } from "../src/comfyui/diagnostics";
import { defaultConnection } from "../src/workflow/catalog";
import type { ApiWorkflow, TaskState } from "../src/types";

const connection = { ...defaultConnection, baseUrl: "https://compute.example/comfy", token: "optimizer-only-private-token" };
const workflow: ApiWorkflow = {
  "12": { class_type: "CheckpointLoaderSimple", inputs: {}, _meta: { title: "Load checkpoint" } },
  "17": { class_type: "KSampler", inputs: {}, _meta: { title: "Main sampler" } },
  "23": { class_type: "SaveImage", inputs: {}, _meta: { title: "Save generated image" } },
};
const completed = { outputs: {}, status: { completed: true, status_str: "success" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
type WireEvent = { type: string; data: Record<string, unknown> };

class BrowserSocket {
  static instances: BrowserSocket[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  readonly constructorArgs: unknown[];
  constructor(...args: unknown[]) {
    this.constructorArgs = args;
    BrowserSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  sendEvent(type: string, data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
  close() { this.onclose?.(); }
}

beforeEach(() => {
  clearCommunicationLog();
  BrowserSocket.instances = [];
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function buffered(events: WireEvent[], history: unknown = { "prompt-a": completed }) {
  const client = new ComfyUIClient(connection, "execution-client");
  await client.connect();
  const socket = BrowserSocket.instances[0];
  for (const event of events) socket.sendEvent(event.type, event.data);
  const fetcher = vi.fn(async () => json(history));
  vi.stubGlobal("fetch", fetcher);
  const states: Partial<TaskState>[] = [];
  const result = client.waitForCompletion("prompt-a", state => states.push(state), new AbortController().signal, workflow);
  return { client, socket, fetcher, states, result };
}

describe("actual ComfyUI execution events", () => {
  it("attempts the standard browser socket when only the optimizer needs authentication, without putting its token in the URL or subprotocol", async () => {
    const client = new ComfyUIClient(connection, "execution-client");
    await client.connect();
    const args = BrowserSocket.instances[0].constructorArgs;
    expect(args).toHaveLength(1);
    expect(String(args[0])).toBe("wss://compute.example/comfy/ws?clientId=execution-client");
    expect(JSON.stringify(args)).not.toContain(connection.token);
    client.disconnect();
  });

  it("can recover through authenticated history when the standard browser socket is rejected", async () => {
    class RejectedSocket extends BrowserSocket {
      constructor(...args: unknown[]) { super(...args); queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("WebSocket", RejectedSocket);
    const client = new ComfyUIClient(connection);
    // Prevent the normal socket-open callback so this models a handshake rejection.
    const connecting = client.connect();
    BrowserSocket.instances[0].onopen = undefined;
    await expect(connecting).rejects.toThrow("WebSocket 连接失败");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer " + connection.token });
      return json({ "prompt-a": completed });
    });
    vi.stubGlobal("fetch", fetcher);
    const states: Partial<TaskState>[] = [];
    await expect(client.waitForCompletion("prompt-a", state => states.push(state), new AbortController().signal, workflow)).resolves.toMatchObject(completed);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states).toContainEqual(expect.objectContaining({ details: expect.stringContaining("实时通道不可用") }));
    expect(JSON.stringify(BrowserSocket.instances[0].constructorArgs)).not.toContain(connection.token);
    client.disconnect();
  });

  it("identifies the executing node and exposes the exact node progress rather than estimating a whole-workflow percentage", async () => {
    const task = await buffered([
      { type: "execution_start", data: { prompt_id: "prompt-a" } },
      { type: "executing", data: { prompt_id: "prompt-a", node: "17" } },
      { type: "progress", data: { prompt_id: "prompt-a", node: "17", value: 2, max: 8 } },
    ]);
    await task.result;
    expect(task.states).toContainEqual(expect.objectContaining({ status: "loading" }));
    expect(task.states).toContainEqual(expect.objectContaining({ status: "generating", execution: expect.objectContaining({ nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler" }) }));
    expect(task.states.at(-1)).toMatchObject({ status: "generating", progress: 25, execution: { nodeId: "17", value: 2, max: 8 } });
    task.client.disconnect();
  });

  it("clears a previous node's fraction when ComfyUI starts the next node", async () => {
    const task = await buffered([
      { type: "executing", data: { prompt_id: "prompt-a", node: "17" } },
      { type: "progress", data: { prompt_id: "prompt-a", node: "17", value: 8, max: 8 } },
      { type: "executing", data: { prompt_id: "prompt-a", node: "23" } },
    ]);
    await task.result;
    const next = task.states.at(-1)!;
    expect(next.progress).toBeUndefined();
    expect(next.execution).toMatchObject({ nodeId: "23", nodeType: "SaveImage", nodeTitle: "Save generated image" });
    expect(next.execution?.value).toBeUndefined();
    expect(next.execution?.max).toBeUndefined();
    task.client.disconnect();
  });

  it("ignores execution, progress, error, cached and completion events belonging to another prompt or lacking prompt identity", async () => {
    const foreignTypes = ["execution_start", "executing", "progress", "progress_state", "execution_cached", "executed", "execution_error", "execution_interrupted"];
    const events = foreignTypes.flatMap(type => [
      { type, data: { prompt_id: "another-prompt", node: "999", value: 7, max: 8, exception_message: "foreign failure", nodes: type === "progress_state" ? { "999": { state: "running", value: 7, max: 8 } } : ["999"] } },
      { type, data: { node: "999", value: 7, max: 8, exception_message: "unattributed failure" } },
    ]);
    const task = await buffered([...events, { type: "executing", data: { prompt_id: "prompt-a", node: "17" } }]);
    await expect(task.result).resolves.toMatchObject(completed);
    expect(task.states).toHaveLength(1);
    expect(JSON.stringify(task.states)).not.toMatch(/999|foreign|unattributed/);
    expect(task.states[0].execution?.nodeId).toBe("17");
    task.client.disconnect();
  });

  it("retains the server's cached and completed node IDs without inventing sampler progress", async () => {
    const task = await buffered([
      { type: "execution_cached", data: { prompt_id: "prompt-a", nodes: ["12"] } },
      { type: "executing", data: { prompt_id: "prompt-a", node: "17" } },
      { type: "executed", data: { prompt_id: "prompt-a", node: "17", output: { images: [{ filename: "private.png" }] } } },
      { type: "executing", data: { prompt_id: "prompt-a", node: "23" } },
    ]);
    await task.result;
    const last = task.states.at(-1)!;
    expect(last.execution?.cachedNodes).toEqual(["12"]);
    expect(last.execution?.completedNodes).toContain("17");
    expect(last.execution?.nodeId).toBe("23");
    expect(last.progress).toBeUndefined();
    expect(JSON.stringify(communicationSnapshot())).not.toContain("private.png");
    task.client.disconnect();
  });

  it("reads modern progress_state node records and maps their actual workflow identities", async () => {
    const task = await buffered([{ type: "progress_state", data: {
      prompt_id: "prompt-a",
      nodes: {
        "12": { node_id: "12", prompt_id: "prompt-a", state: "finished", value: 1, max: 1 },
        "17": { node_id: "17", prompt_id: "prompt-a", state: "running", value: 3, max: 12 },
      },
    } }]);
    await task.result;
    expect(task.states.at(-1)).toMatchObject({ status: "generating", progress: 25, execution: { nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler", value: 3, max: 12, completedNodes: ["12"] } });
    task.client.disconnect();
  });

  it("uses a server-reported node type rather than silently substituting a stale saved type", async () => {
    const task = await buffered([{ type: "progress_state", data: {
      prompt_id: "prompt-a",
      nodes: { "17": { node_id: "17", prompt_id: "prompt-a", node_type: "CustomSamplerV2", state: "running", value: 1, max: 10 } },
    } }]);
    await task.result;
    expect(task.states.at(-1)?.execution).toMatchObject({ nodeId: "17", nodeType: "CustomSamplerV2", value: 1, max: 10 });
    task.client.disconnect();
  });

  it("does not attribute a modern node record carrying a different prompt ID to the active task", async () => {
    const task = await buffered([{ type: "progress_state", data: {
      prompt_id: "prompt-a",
      nodes: {
        "17": { node_id: "17", prompt_id: "prompt-a", state: "running", value: 1, max: 10 },
        "999": { node_id: "999", prompt_id: "another-prompt", state: "running", value: 9, max: 10 },
      },
    } }]);
    await task.result;
    expect(task.states.at(-1)).toMatchObject({ progress: 10, execution: { nodeId: "17" } });
    expect(JSON.stringify(task.states)).not.toContain("999");
    task.client.disconnect();
  });

  it("continues receiving current-task events while a history request is in flight", async () => {
    const client = new ComfyUIClient(connection);
    await client.connect();
    let finishHistory!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finishHistory = resolve; })));
    const states: Partial<TaskState>[] = [];
    const result = client.waitForCompletion("prompt-a", state => states.push(state), new AbortController().signal, workflow);
    const socket = BrowserSocket.instances[0];
    socket.sendEvent("executing", { prompt_id: "prompt-a", node: "17" });
    socket.sendEvent("progress", { prompt_id: "another-prompt", node: "23", value: 9, max: 10 });
    socket.sendEvent("progress", { prompt_id: "prompt-a", node: "17", value: 1, max: 4 });
    expect(states.at(-1)).toMatchObject({ progress: 25, execution: { nodeId: "17", value: 1, max: 4 } });
    finishHistory(json({ "prompt-a": completed }));
    await result;
    client.disconnect();
  });

  it("does not replay a successful history's old execution_start over newer live node progress", async () => {
    const task = await buffered([
      { type: "execution_start", data: { prompt_id: "prompt-a" } },
      { type: "executing", data: { prompt_id: "prompt-a", node: "17" } },
      { type: "progress", data: { prompt_id: "prompt-a", node: "17", value: 8, max: 8 } },
    ], { "prompt-a": { ...completed, status: { ...completed.status, messages: [
      ["execution_start", { prompt_id: "prompt-a", timestamp: 1 }],
      ["execution_cached", { prompt_id: "prompt-a", nodes: ["12"], timestamp: 2 }],
      ["execution_success", { prompt_id: "prompt-a", timestamp: 3 }],
    ] } } });
    await task.result;
    const firstGenerating = task.states.findIndex(state => state.status === "generating");
    expect(firstGenerating).toBeGreaterThanOrEqual(0);
    expect(task.states.slice(firstGenerating).some(state => state.status === "loading")).toBe(false);
    expect(task.states.at(-1)).toMatchObject({ status: "generating", progress: 100, execution: { nodeId: "17", value: 8, max: 8 } });
    task.client.disconnect();
  });
});

describe("ComfyUI error identity and original diagnostics", () => {
  const failure = {
    prompt_id: "prompt-a", node_id: "17", node_type: "KSampler",
    exception_type: "RuntimeError", exception_message: "CUDA out of memory. Tried to allocate 2.00 GiB",
    traceback: ["File sampler.py, line 8", "RuntimeError: CUDA out of memory"],
    current_inputs: { seed: [42] }, current_outputs: ["12"], executed: ["12"],
  };

  it("keeps a websocket failure's actual node, exact exception and complete original error payload", async () => {
    const task = await buffered([{ type: "execution_error", data: failure }]);
    const error = await task.result.catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.status).toBe("failed");
    expect(error.message).toContain(failure.exception_message);
    expect(error.execution).toMatchObject({ nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler" });
    expect(JSON.parse(error.details)).toEqual(failure);
    expect(friendlyError(error).error).toContain(failure.exception_message);
    expect(friendlyError(error).details).toBe(error.details);
    expect(JSON.stringify(communicationSnapshot())).not.toMatch(/sampler\.py|allocate 2\.00/);
    task.client.disconnect();
  });

  it("publishes a live execution failure immediately while history is pending, and never lets a stale success replace that failure", async () => {
    const client = new ComfyUIClient(connection);
    await client.connect();
    let finishHistory!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finishHistory = resolve; })));
    const states: Partial<TaskState>[] = [];
    const result = client.waitForCompletion("prompt-a", state => states.push(state), new AbortController().signal, workflow);
    const observed = result.catch(reason => reason);
    const socket = BrowserSocket.instances[0];
    socket.sendEvent("executing", { prompt_id: "prompt-a", node: "17" });
    socket.sendEvent("progress", { prompt_id: "prompt-a", node: "17", value: 1, max: 4 });
    socket.sendEvent("execution_error", failure);
    // No history response has been supplied: the canvas must already receive the failure.
    expect(states.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining(failure.exception_message), execution: { nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler" } });
    expect(states.at(-1)?.progress).toBeUndefined();
    expect(JSON.parse(states.at(-1)!.details!)).toEqual(failure);
    finishHistory(json({ "prompt-a": completed }));
    const error = await observed;
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.status).toBe("failed");
    expect(error.message).toContain(failure.exception_message);
    expect(JSON.parse(error.details)).toEqual(failure);
    expect(states.at(-1)?.status).toBe("failed");
    client.disconnect();
  });

  it("retains the server's interruption payload while classifying it as cancelled", async () => {
    const interrupted = { prompt_id: "prompt-a", node_id: "17", node_type: "KSampler", executed: ["12"] };
    const task = await buffered([{ type: "execution_interrupted", data: interrupted }]);
    const error = await task.result.catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.status).toBe("cancelled");
    expect(error.execution).toMatchObject({ nodeId: "17", nodeType: "KSampler" });
    expect(JSON.parse(error.details)).toEqual(interrupted);
    task.client.disconnect();
  });

  it("recovers the same original node failure through ComfyUI history when no socket is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ "prompt-a": { outputs: {}, status: { completed: false, status_str: "error", messages: [["execution_start", { prompt_id: "prompt-a" }], ["execution_error", failure]] } } })));
    const client = new ComfyUIClient(connection);
    const error = await client.waitForCompletion("prompt-a", vi.fn(), new AbortController().signal, workflow).catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.message).toContain(failure.exception_message);
    expect(error.execution).toMatchObject({ nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler" });
    expect(JSON.parse(error.details)).toEqual(failure);
  });

  it("keeps all server validation errors and associates the first rejected node before a prompt has been accepted", async () => {
    const response = {
      error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "" },
      node_errors: {
        "17": { class_type: "KSampler", errors: [{ type: "value_not_in_list", message: "Value not in list", details: "sampler_name: 'missing'" }], dependent_outputs: ["23"] },
        "23": { class_type: "SaveImage", errors: [{ type: "required_input_missing", message: "Required input is missing", details: "images" }], dependent_outputs: ["23"] },
      },
    };
    const fetcher = vi.fn(async () => json(response, 400));
    vi.stubGlobal("fetch", fetcher);
    const error = await new ComfyUIClient(connection).queuePrompt(workflow, "request-a").catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.status).toBe("failed");
    expect(error.execution).toMatchObject({ nodeId: "17", nodeType: "KSampler", nodeTitle: "Main sampler" });
    expect(error.message).toContain("Prompt outputs failed validation");
    expect(error.message).toContain("sampler_name: 'missing'");
    expect(error.message).toContain("Required input is missing");
    expect(JSON.parse(error.details)).toEqual(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never rewrites a server execution error into a different friendly cause", () => {
    const error = new ExecutionError(failure.exception_message, "failed", JSON.stringify(failure));
    expect(friendlyError(error)).toMatchObject({ error: failure.exception_message, details: JSON.stringify(failure) });
  });
});
