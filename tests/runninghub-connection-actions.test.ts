import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/types";

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../src/stores/store", () => ({ useStore: {
  getState: () => fixture.state,
  setState: (patch: object) => Object.assign(fixture.state, patch),
} }));

import { RunningHubClient } from "../src/runninghub/client";
import { checkRunningHubConnection } from "../src/settings/runninghub-connection-actions";

const connection = (site = "cn", token = "private-fixture-key"): Connection => ({
  name: "RunningHub", baseUrl: `https://www.runninghub.${site}`, token,
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60,
});
const state = () => fixture.state as unknown as {
  computeProvider: "comfyui" | "runninghub";
  project: object;
  connectionState: string;
  connectionInfo: string;
  runningHubConnection: Connection;
  runningHubConnections: { cn: Connection; ai: Connection };
  runningHubConnectionState: string;
  runningHubConnectionInfo: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  const cn = connection(), ai = connection("ai", "other-private-fixture");
  fixture.state = {
    computeProvider: "comfyui", project: { id: "same-project", canvases: [{ id: "same-canvas" }] },
    connectionState: "connected", connectionInfo: "Cloud remains connected",
    runningHubConnection: cn, runningHubConnections: { cn, ai },
    runningHubConnectionState: "offline", runningHubConnectionInfo: "尚未检测",
  };
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Tests must not contact remote services"); }));
  vi.spyOn(RunningHubClient.prototype, "validateKey").mockResolvedValue({ valid: true });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared RunningHub connection checks", () => {
  it("shows RH coins separately from wallet without rejecting a coin-funded account with zero money", async () => {
    vi.mocked(RunningHubClient.prototype.validateKey).mockResolvedValueOnce({ valid: true, remainCoins: "500", remainMoney: "0", currency: "CNY", apiType: "NORMAL" });
    const result = await checkRunningHubConnection(state().runningHubConnection);
    expect(state().runningHubConnectionState).toBe("connected");
    expect(result).toContain("RH 币：500");
    expect(result).toContain("钱包：0 CNY");
    expect(result).toContain("接口返回类型：消费级会员（NORMAL）");
    expect(state().runningHubConnectionInfo).toContain("RH 币：500");
  });
  it("refreshes RunningHub independently without selecting it or changing the project/cloud connection", async () => {
    const project = state().project, saved = state().runningHubConnection;
    const result = await checkRunningHubConnection(saved);
    expect(result).toBe("API Key 验证通过。");
    expect(state().runningHubConnectionState).toBe("connected");
    expect(state().runningHubConnectionInfo).toBe("RunningHub API Key 检测通过。");
    expect(state().computeProvider).toBe("comfyui");
    expect(state().project).toBe(project);
    expect(state().runningHubConnection).toBe(saved);
    expect(state().connectionState).toBe("connected");
    expect(state().connectionInfo).toBe("Cloud remains connected");
    expect(RunningHubClient.prototype.validateKey).toHaveBeenCalledOnce();
  });

  it("reports a missing key locally without sending any request", async () => {
    const empty = connection("cn", "   ");
    state().runningHubConnection = state().runningHubConnections.cn = empty;
    const result = await checkRunningHubConnection(empty);
    expect(result).toContain("填写本站 RunningHub API Key");
    expect(state().runningHubConnectionState).toBe("offline");
    expect(state().runningHubConnectionInfo).toBe(result);
    expect(RunningHubClient.prototype.validateKey).not.toHaveBeenCalled();
  });

  it("redacts credentials from bounded failure feedback and the shared status", async () => {
    const key = state().runningHubConnection.token;
    vi.mocked(RunningHubClient.prototype.validateKey).mockRejectedValueOnce(new Error(`Rejected ${key}, repeated ${key} ` + "x".repeat(1000)));
    const result = await checkRunningHubConnection(state().runningHubConnection);
    expect(result).toContain("[已隐藏]");
    expect(result).not.toContain(key);
    expect(result!.length).toBeLessThanOrEqual(805);
    expect(state().runningHubConnectionState).toBe("offline");
    expect(state().runningHubConnectionInfo).toBe(result);
  });

  it("ignores a response for credentials replaced while validation is pending", async () => {
    const response = deferred<{ valid: true }>();
    vi.mocked(RunningHubClient.prototype.validateKey).mockReturnValueOnce(response.promise);
    const old = checkRunningHubConnection(state().runningHubConnection);
    expect(state().runningHubConnectionState).toBe("connecting");
    state().runningHubConnection = state().runningHubConnections.cn = connection("cn", "replacement-key");
    state().runningHubConnectionState = "offline";
    state().runningHubConnectionInfo = "配置已更改，等待检测。";
    response.resolve({ valid: true });
    expect(await old).toBeUndefined();
    expect(state().runningHubConnectionState).toBe("offline");
    expect(state().runningHubConnectionInfo).toBe("配置已更改，等待检测。");
  });

  it.each([false, true])("cancels superseded validation and lets only the newest check publish (new key: %s)", async replaced => {
    const firstResponse = deferred<{ valid: true }>(), secondResponse = deferred<{ valid: true }>();
    const signals: AbortSignal[] = [];
    vi.mocked(RunningHubClient.prototype.validateKey).mockImplementationOnce(signal => {
      signals.push(signal!); return firstResponse.promise;
    }).mockImplementationOnce(signal => {
      signals.push(signal!); return secondResponse.promise;
    });
    const first = checkRunningHubConnection(state().runningHubConnection);
    if (replaced) state().runningHubConnection = state().runningHubConnections.cn = connection("cn", "new-key");
    const second = checkRunningHubConnection(state().runningHubConnection);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    secondResponse.resolve({ valid: true });
    expect(await second).toBe("API Key 验证通过。");
    firstResponse.reject(new Error("Old failed request"));
    expect(await first).toBeUndefined();
    expect(state().runningHubConnectionState).toBe("connected");
    expect(state().runningHubConnectionInfo).toBe("RunningHub API Key 检测通过。");
  });

  it("verifies an inactive saved site without overwriting the active site's status", async () => {
    state().runningHubConnectionState = "connected";
    state().runningHubConnectionInfo = "CN result";
    const result = await checkRunningHubConnection(state().runningHubConnections.ai);
    expect(result).toBe("API Key 验证通过。");
    expect(state().runningHubConnection.baseUrl).toBe("https://www.runninghub.cn");
    expect(state().runningHubConnectionState).toBe("connected");
    expect(state().runningHubConnectionInfo).toBe("CN result");
  });

  it("does not return an inactive site's result after that site's key was replaced", async () => {
    const response = deferred<{ valid: true }>();
    vi.mocked(RunningHubClient.prototype.validateKey).mockReturnValueOnce(response.promise);
    const old = checkRunningHubConnection(state().runningHubConnections.ai);
    state().runningHubConnections.ai = connection("ai", "replaced-inactive-key");
    response.resolve({ valid: true });
    expect(await old).toBeUndefined();
    expect(state().runningHubConnectionInfo).toBe("尚未检测");
  });
});
