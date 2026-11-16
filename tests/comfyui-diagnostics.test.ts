import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIClient } from "../src/comfyui/client";
import { clearCommunicationLog, communicationSnapshot, logHttp, logWebSocket, COMMUNICATION_LOG_LIMIT, subscribeCommunication } from "../src/comfyui/diagnostics";
import { defaultConnection } from "../src/workflow/catalog";
const baseUrl = "https://compute.example/comfy";
beforeEach(clearCommunicationLog);
afterEach(() => vi.unstubAllGlobals());

describe("bounded redacted communication diagnostics", () => {
  it("distinguishes RunningHub account, upload and application requests without retaining IDs or secrets", () => {
    const paths = ["/uc/openapi/accountStatus", "/openapi/v2/media/upload/binary", "/task/openapi/ai-app/run", "/openapi/v2/run/ai-app/2097920992202022914", "/task/openapi/outputs"];
    for (const path of paths) logHttp("https://www.runninghub.cn", path + "?apiKey=private-key", "POST", "request");
    expect(communicationSnapshot().map(entry => entry.route)).toEqual([paths[0], paths[1], paths[2], "/openapi/v2/run/ai-app/:appId", paths[4]]);
    expect(JSON.stringify(communicationSnapshot())).not.toMatch(/private-key|2097920992202022914/);
  });
  it("whitelists metadata and discards secrets, credentials, file queries, custom paths and error text", () => {
    logHttp("https://user:password@compute.example/comfy", "/view?filename=private-picture.png&token=secret", "GET", "response", { status: 200, durationMs: 2.7 });
    logHttp(baseUrl, "/history/private-user-title", "GET", "request");
    logHttp(baseUrl, "/api/jobs/private-id/cancel", "POST", "request");
    logHttp(baseUrl, "/custom/private-prompt", "SECRET METHOD", "error", { errorKind: "credential private-message" });
    logWebSocket(baseUrl, "event", { type: "execution_error", data: { prompt_id: "task-id", node: "17:22", exception_message: "private prompt", traceback: ["secret"], output: { images: ["private-media"] }, token: "token-value" } });
    logWebSocket(baseUrl, "event", { type: "custom secret event", data: { prompt_id: "private prompt with spaces", node: "../../private", value: Infinity } });
    const snapshot = communicationSnapshot();
    expect(snapshot.map(entry => entry.route)).toEqual(["/view", "/history/:promptId", "/api/jobs/:promptId/cancel", "/其他接口", "/ws", "/ws"]);
    expect(snapshot[0]).toMatchObject({ origin: "https://compute.example", durationMs: 3 });
    expect(snapshot[3]).toMatchObject({ method: "OTHER", errorKind: "Error" });
    expect(snapshot[4]).toMatchObject({ eventType: "execution_error", promptId: "task-id", nodeId: "17:22" });
    expect(snapshot[5]).toMatchObject({ eventType: "custom_event" });
    expect(snapshot[5]).not.toHaveProperty("promptId"); expect(snapshot[5]).not.toHaveProperty("value");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|password|secret|token-value|credential/);
  });

  it("keeps immutable stable snapshots limited to the newest 250 records and notifies subscribers", () => {
    const listener = vi.fn(); const stop = subscribeCommunication(listener);
    const initial = communicationSnapshot();
    for (let index = 0; index < COMMUNICATION_LOG_LIMIT + 20; index++) logHttp(baseUrl, "/queue", "GET", "response", { status: 200 });
    const current = communicationSnapshot();
    expect(initial).toHaveLength(0); expect(current).toHaveLength(COMMUNICATION_LOG_LIMIT); expect(Object.isFrozen(current)).toBe(true); expect(Object.isFrozen(current[0])).toBe(true);
    expect(communicationSnapshot()).toBe(current); expect(listener).toHaveBeenCalledTimes(COMMUNICATION_LOG_LIMIT + 20);
    stop(); clearCommunicationLog(); expect(listener).toHaveBeenCalledTimes(COMMUNICATION_LOG_LIMIT + 20); expect(communicationSnapshot()).toHaveLength(0);
  });

  it("records actual HTTP request, response and transport failure without storing submitted workflow or auth", async () => {
    const client = new ComfyUIClient({ ...defaultConnection, baseUrl, token: "real-auth-secret" });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: "task" }), { status: 200 })).mockRejectedValueOnce(new TypeError("network private details"));
    vi.stubGlobal("fetch", fetcher);
    await client.queuePrompt({ "1": { class_type: "Text", inputs: { text: "private creative prompt", image: "private.png" } } }, "request-id");
    await expect(client.getQueue()).rejects.toThrow();
    expect(communicationSnapshot().map(entry => [entry.route, entry.stage])).toEqual([["/prompt", "request"], ["/prompt", "response"], ["/queue", "request"], ["/queue", "error"]]);
    expect(communicationSnapshot()[1].requestId).toBe(communicationSnapshot()[0].id); expect(communicationSnapshot()[3]).toMatchObject({ errorKind: "TypeError" });
    expect(JSON.stringify(communicationSnapshot())).not.toMatch(/real-auth-secret|private|request-id/);
  });

  it("records real websocket lifecycle and event progress, ignoring binary preview payloads", async () => {
    let socket: Socket;
    class Socket {
      onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: unknown }) => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      close() { this.onclose?.(); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const client = new ComfyUIClient({ ...defaultConnection, baseUrl }); await client.connect();
    socket!.onmessage?.({ data: JSON.stringify({ type: "progress", data: { prompt_id: "task-id", node: "22", value: 2, max: 8, image: "private-image", prompt: "private-text" } }) });
    socket!.onmessage?.({ data: new Blob(["private-binary"]) });
    socket!.onmessage?.({ data: JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 3 } } } }) });
    client.disconnect();
    expect(communicationSnapshot().map(entry => entry.stage)).toEqual(["connect", "open", "event", "event", "close"]);
    expect(communicationSnapshot()[2]).toMatchObject({ eventType: "progress", promptId: "task-id", nodeId: "22", value: 2, max: 8 });
    expect(communicationSnapshot()[3]).toMatchObject({ queueRemaining: 3 });
    expect(JSON.stringify(communicationSnapshot())).not.toMatch(/private|clientId/);
  });
});
