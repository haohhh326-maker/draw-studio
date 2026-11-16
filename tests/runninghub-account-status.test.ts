import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningHubClient } from "../src/runninghub/client";

const token = "fixture-account-key-do-not-return";
const connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token, authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 2 };
const client = () => new RunningHubClient(connection);
function accountResponse(data: unknown) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

describe("RunningHub read-only account balances", () => {
  it("preserves positive RH coins alongside a zero wallet balance", async () => {
    const fetcher = accountResponse({ remainCoins: "1250.50", remainMoney: "0", currentTaskCounts: 0, currency: "CNY", apiType: "NORMAL" });
    expect(await client().validateKey()).toEqual({ valid: true, remainCoins: "1250.50", remainMoney: "0", currentTaskCounts: "0", currency: "CNY", apiType: "NORMAL" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain("/uc/openapi/accountStatus");
  });

  it("does not conflate zero RH coins and a positive wallet balance", async () => {
    accountResponse({ remainCoins: 0, remainMoney: 18.25, currentTaskCounts: " 2 ", currency: "USD" });
    expect(await client().validateKey()).toEqual({ valid: true, remainCoins: "0", remainMoney: "18.25", currentTaskCounts: "2", currency: "USD" });
  });

  it("keeps exact decimal strings rather than rounding through a JavaScript number", async () => {
    accountResponse({ remainCoins: " 9007199254740993.12345 ", remainMoney: "00012.5000" });
    expect(await client().validateKey()).toEqual({ valid: true, remainCoins: "9007199254740993.12345", remainMoney: "00012.5000" });
  });

  it("retains signed balances and expands finite numeric exponent notation", async () => {
    accountResponse({ remainCoins: "-2.50", remainMoney: -1e-7, currentTaskCounts: 1e21 });
    expect(await client().validateKey()).toEqual({ valid: true, remainCoins: "-2.50", remainMoney: "-0.0000001", currentTaskCounts: "1000000000000000000000" });
  });

  it.each([{}, { remainCoins: null, remainMoney: false, currentTaskCounts: [] }, { remainCoins: token, remainMoney: "Infinity", currentTaskCounts: {} }, { remainCoins: "1e3", remainMoney: "", currentTaskCounts: "NaN" }])("omits unavailable or malformed values without inventing zero or exposing extra response fields %#", async data => {
    accountResponse({ ...data, apiKey: token, privateAccountDetails: token });
    const status = await client().validateKey();
    expect(status).toEqual({ valid: true });
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("leaves the existing valid, currency and API type contract unchanged when balances are absent", async () => {
    accountResponse({ currency: "CNY", apiType: "NORMAL" });
    expect(await client().validateKey()).toEqual({ valid: true, currency: "CNY", apiType: "NORMAL" });
  });
});
