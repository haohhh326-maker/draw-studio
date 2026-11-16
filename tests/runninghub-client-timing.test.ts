import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningHubClient } from "../src/runninghub/client";
import type { Connection, TaskState, WorkflowDefinition } from "../src/types";

const connection: Connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token: "fixture-key", timeoutMinutes: 2 };
const definition: WorkflowDefinition = { id: "rh.timing", name: "Timing", description: "", family: "Fixture", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], output: { nodeId: "9", field: "images", kind: "image" }, template: { "9": { class_type: "SaveImage", inputs: {} } }, runninghub: { workflowId: "123456789", baseUrl: connection.baseUrl } };
const output = (taskCostTime?: unknown) => ({ nodeId: "9", fileUrl: "https://cdn.example/result.png", fileType: "png", taskCostTime });
const success = (data: unknown) => ({ code: 0, msg: "success", data });
const makeClient = (v2 = false) => new RunningHubClient(connection, "timing-test", v2 ? { ...definition, runninghub: { ...definition.runninghub!, kind: "app", apiVersion: "v2" } } : definition);
function transport(...responses: unknown[]) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    if (!responses.length) throw new Error("Unexpected request");
    return new Response(JSON.stringify(responses.shift()));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("RunningHub client task timing", () => {
  it("takes the maximum task duration rather than summing repeated per-output values", async () => {
    transport(success([output("130"), output("130"), output(95), output("130.5")]));
    const history = await makeClient().waitForCompletion("task-1", () => {}, new AbortController().signal);
    expect(history.runningHubTiming).toEqual({ providerDurationSeconds: 130.5 });
  });

  it("omits invalid or absent timing and accepts an explicitly reported zero", async () => {
    const values = [undefined, null, "", " ", "-1", -1, "NaN", "Infinity", false, {}, "130 seconds", "0x10", "1e309"];
    const fetcher = transport(...values.map(value => success([output(value)])), success([output("0")]));
    for (const _ of values) expect((await makeClient().waitForCompletion("task-invalid", () => {}, new AbortController().signal)).runningHubTiming).toBeUndefined();
    expect((await makeClient().waitForCompletion("task-zero", () => {}, new AbortController().signal)).runningHubTiming).toEqual({ providerDurationSeconds: 0 });
    expect(fetcher).toHaveBeenCalledTimes(values.length + 1);
  });

  it("does not invent V2 timing and retains its explicitly reported usage duration", async () => {
    transport({ status: "SUCCESS", results: [output()] }, { status: "SUCCESS", usage: { taskCostTime: "40.25" }, results: [output()] });
    expect((await makeClient(true).waitForCompletion("v2-1", () => {}, new AbortController().signal)).runningHubTiming).toBeUndefined();
    expect((await makeClient(true).waitForCompletion("v2-2", () => {}, new AbortController().signal)).runningHubTiming).toEqual({ providerDurationSeconds: 40.25 });
  });

  it("reads an accepted task's timing with one outputs query and no submission or download", async () => {
    const fetcher = transport(success([output("130"), output("130")]));
    expect(await makeClient().readTaskTiming("accepted-task")).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/task/openapi/outputs");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ apiKey: connection.token, taskId: "accepted-task" });
  });

  it("returns no timing for a still-running task, even when it carries partial outputs", async () => {
    const fetcher = transport(success({ taskStatus: "RUNNING", outputs: [output("9")] }));
    expect(await makeClient().readTaskTiming("running-task")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a single V2 timing query and forwards cancellation", async () => {
    const fetcher = transport({ status: "SUCCESS", usage: { taskCostTime: "130" }, results: [output()] });
    const abort = new AbortController();
    expect(await makeClient(true).readTaskTiming("v2-task", abort.signal)).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/openapi/v2/query");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ taskId: "v2-task" });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    abort.abort();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("immediately reads outputs once after the legacy status endpoint confirms success", async () => {
    vi.useFakeTimers();
    const fetcher = transport(success(null), success("SUCCESS"), success([output("130")]));
    const states: Partial<TaskState>[] = [];
    const history = await makeClient().waitForCompletion("finished-task", state => states.push(state), new AbortController().signal);
    expect(history.runningHubTiming).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(["/task/openapi/outputs", "/task/openapi/status", "/task/openapi/outputs"]);
    expect(states.slice(1)).toContainEqual(expect.objectContaining({
      status: "saving", details: expect.stringContaining("等待结果地址"),
    }));
  });

  it("uses an already returned success state without another status request and never busy-polls missing outputs", async () => {
    vi.useFakeTimers();
    const fetcher = transport(success({ taskStatus: "SUCCESS" }), success({ taskStatus: "SUCCESS" }), success([output("130")]));
    const run = makeClient().waitForCompletion("finished-no-output", () => {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await run).runningHubTiming).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith("/task/openapi/outputs"))).toBe(true);
  });

  it("limits immediate refresh to once even when the fallback status repeatedly confirms success", async () => {
    vi.useFakeTimers();
    const fetcher = transport(success(null), success("SUCCESS"), success(null), success("SUCCESS"), success([output("130")]));
    const run = makeClient().waitForCompletion("terminal-status-no-files", () => {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect((await run).runningHubTiming).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not complete or immediately poll again for RUNNING with partial results", async () => {
    vi.useFakeTimers();
    const fetcher = transport(success({ taskStatus: "RUNNING", outputs: [output("10")] }), success([output("130")]));
    const run = makeClient().waitForCompletion("partial-task", () => {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await run).runningHubTiming).toEqual({ providerDurationSeconds: 130 });
  });

  it("does not retry or submit when a timing query fails, and rejects a missing task ID locally", async () => {
    const fetcher = transport({ code: 805, msg: "APIKEY_TASK_STATUS_ERROR", data: { failedReason: "Fixture failure" } });
    await expect(makeClient().readTaskTiming("")).rejects.toThrow("taskId");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(makeClient().readTaskTiming("failed-task")).rejects.toThrow("Fixture failure");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/task/openapi/outputs");
  });

  it("rechecks the original task immediately when a background canvas becomes visible", async () => {
    vi.useFakeTimers();
    const page = new EventTarget() as EventTarget & { visibilityState: string };
    page.visibilityState = "hidden";
    vi.stubGlobal("document", page);
    const fetcher = transport(success({ taskStatus: "RUNNING" }), success([output("130")]));
    const run = makeClient().waitForCompletion("visible-task", () => {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect((await run).runningHubTiming).toEqual({ providerDurationSeconds: 130 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => JSON.parse(String(call[1]?.body)).taskId === "visible-task")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll for a hidden visibility event and releases wake listeners on cancellation", async () => {
    vi.useFakeTimers();
    const page = new EventTarget() as EventTarget & { visibilityState: string };
    page.visibilityState = "hidden";
    const remove = vi.spyOn(page, "removeEventListener");
    vi.stubGlobal("document", page);
    const fetcher = transport(success({ taskStatus: "RUNNING" }));
    const abort = new AbortController();
    const run = makeClient().waitForCompletion("cancel-wake", () => {}, abort.signal);
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
