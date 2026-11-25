import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAutoDLCommand } from "../browser-extensions/autodl/autodl-page.js";

const request = vi.fn<typeof fetch>();
const boot = () => runAutoDLCommand("power-on", "pro-fixture", Date.now() + 45_000);
const preflight = () => runAutoDLCommand("preflight", "pro-fixture", Date.now() + 45_000);
const data = (value: unknown) => Response.json({ code: "Success", data: value });
const paygInstance = { uuid: "pro-fixture", status: "shutdown", charge_type: "payg", snapshot_gpu_alias_name: "RTX 5090" };
const instanceList = (row: object) => data({ list: [row], result_total: 1 });

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("location", new URL("https://www.autodl.art/app/deploy"));
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "token" ? "synthetic-website-credential" : null });
  vi.stubGlobal("fetch", request);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["InternalError", "BadRequest"])("recognizes an explicit inventory refusal under %s without forwarding website messages", async (code) => {
  request.mockResolvedValue(Response.json({
    code,
    msg: "当前算力规格暂无库存, 请修改配置或稍等再试",
    data: { unrelated: "private-website-data" },
  }));
  expect(await boot()).toEqual({ ok: false, errorCode: "NO_GPU_CAPACITY", remoteCode: code, httpStatus: 200 });
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toBe("/api/v1/adl_server/instance/pro/power_on");
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ instance_uuid: "pro-fixture", payload: "" });
});

it.each(["InternalError", "BadRequest"])("keeps an unclear %s ambiguous with only sanitized diagnostics", async (code) => {
  request.mockResolvedValue(Response.json({ code, msg: "查询当前算力规格暂无库存提示失败", data: { secret: "synthetic-secret" } }));
  expect(await boot()).toEqual({ ok: false, errorCode: "POWER_UNKNOWN", remoteCode: code, httpStatus: 200 });
});

it.each([
  ["BadRequest", "余额不足，请充值", "INSUFFICIENT_BALANCE"],
  ["BadRequest", "子账号余额不足，请联系主账号", "INSUFFICIENT_BALANCE"],
  ["InternalError", "实例已到期, 请续费", "INSTANCE_EXPIRED"],
])("recognizes %s with a known refusal and returns only the allowed diagnostics", async (code, msg, errorCode) => {
  const requestId = "ab0123456789abcd0123456789abcd01";
  request.mockResolvedValue(Response.json({ code, msg, request_id: requestId, data: { token: "private" } }));
  expect(await boot()).toEqual({ ok: false, errorCode, remoteCode: code, httpStatus: 200, requestId });
});

it("does not forward a request ID with unexpected characters or shape", async () => {
  request.mockResolvedValue(Response.json({ code: "BadRequest", request_id: "abcdefghijklmnopqrstuvwxyz0123456789", msg: "other" }));
  expect(await boot()).toEqual({ ok: false, errorCode: "POWER_UNKNOWN", remoteCode: "BadRequest", httpStatus: 200 });
});

it("checks the exact instance's pay-as-you-go price and wallet without attempting to boot", async () => {
  request.mockResolvedValueOnce(data({
    list: [{ ...paygInstance, uuid: "pro-unrelated", snapshot_gpu_alias_name: "other" }, paygInstance], result_total: 2,
  }))
    .mockResolvedValueOnce(data({ assets: 2560, voucher_balance: 0, unrelated: "private" }))
    .mockResolvedValueOnce(data({ payg_price: 3080, unrelated: "private" }));
  expect(await preflight()).toEqual({ ok: false, errorCode: "INSUFFICIENT_BALANCE" });
  expect(request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
    ["/api/v1/adl_server/instance/pro?page_index=1&page_size=10", "GET"],
    ["/api/v1/adl_server/wallet/balance?charge_type=payg&product_type=instance_pro&gpu_name=RTX+5090", "GET"],
    ["/api/v1/adl_server/instance/pro/snapshot?instance_uuid=pro-fixture", "GET"],
  ]);
});

it.each([
  [2560, 520], [0, 3080], [-100, 3080],
])("accepts sufficient eligible funds or a covering voucher with balance %i and voucher %i", async (assets, voucher_balance) => {
  request.mockResolvedValueOnce(instanceList(paygInstance))
    .mockResolvedValueOnce(data({ assets, voucher_balance }))
    .mockResolvedValueOnce(data({ payg_price: 3080 }));
  expect(await preflight()).toEqual({ ok: true, value: { status: "shutdown" } });
});

it.each([
  [2000, 3080, 0, "INSUFFICIENT_BALANCE"],
  [3080, 2000, 0, "INSUFFICIENT_BALANCE"],
  [3080, 2000, 1080, "ready"],
])("checks both subaccount and primary-account funding", async (assets, primary_account_assets, voucher_balance, outcome) => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === "token" ? "synthetic-website-credential" : JSON.stringify({ sub_name: "fixture-subaccount" }),
  });
  request.mockResolvedValueOnce(instanceList(paygInstance))
    .mockResolvedValueOnce(data({ assets, primary_account_assets, voucher_balance }))
    .mockResolvedValueOnce(data({ payg_price: 3080 }));
  expect(await preflight()).toEqual(outcome === "ready" ? { ok: true, value: { status: "shutdown" } } : { ok: false, errorCode: outcome });
  expect(request.mock.calls.every(([path]) => String(path).startsWith("/api/v1/adl_server/sub_user/"))).toBe(true);
});

it("rejects expired prepaid instances without a wallet call", async () => {
  request.mockResolvedValueOnce(instanceList({
    ...paygInstance, charge_type: "prepay", expired_at: { Valid: true, Time: "2000-01-01T00:00:00.000Z" },
  }));
  expect(await preflight()).toEqual({ ok: false, errorCode: "INSTANCE_EXPIRED" });
  expect(request).toHaveBeenCalledOnce();
});

it.each(["running", "starting", "shutting_down", "migrate_failed"])("returns already-changed status %s without consulting the wallet", async status => {
  request.mockResolvedValueOnce(instanceList({ ...paygInstance, status }));
  expect(await preflight()).toEqual({ ok: true, value: { status } });
  expect(request).toHaveBeenCalledOnce();
});

it("keeps a missing or malformed quote from being interpreted as a zero-price offer", async () => {
  request.mockResolvedValueOnce(instanceList(paygInstance))
    .mockResolvedValueOnce(data({ assets: 2560, voucher_balance: 0 })).mockResolvedValueOnce(data({ exempt: false }));
  expect(await preflight()).toEqual({ ok: false, errorCode: "CONTRACT_ERROR" });
});

it("does not send expired commands and distinguishes gateway errors and state conflicts", async () => {
  expect(await runAutoDLCommand("power-on", "pro-fixture", Date.now())).toEqual({ ok: false, errorCode: "COMMAND_EXPIRED" });
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(Response.json({ code: "BadGateway" }, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ code: "InstanceStarting" }, { status: 409 }));
  expect(await boot()).toEqual({ ok: false, errorCode: "POWER_UNKNOWN", httpStatus: 502 });
  expect(await boot()).toEqual({ ok: false, errorCode: "POWER_STATE_CONFLICT", remoteCode: "InstanceStarting", httpStatus: 409 });
});
