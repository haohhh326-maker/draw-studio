import { expect, it } from "vitest";
import { connectionDraft, saveConnectionDraft, updateConnectionDraft } from "../src/settings/ConnectionPopover";
import type { Connection } from "../src/types";

const current: Connection = {
  name: "AutoDL 工作站",
  baseUrl: "https://canvas.example/canvas/comfy",
  token: "existing-token",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  timeoutMinutes: 60,
};

it("keeps the shared cloud token in the editable draft while normalizing the saved connection", () => {
  expect(connectionDraft(current)).toEqual({
    name: "AutoDL 工作站",
    baseUrl: "https://canvas.example/canvas/comfy",
    token: "existing-token",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  });
  const saved = saveConnectionDraft(current, {
    ...connectionDraft(current),
    name: "  我的云端  ",
    baseUrl: " https://canvas.example/canvas/comfy ",
    token: " next-token ",
    authHeader: " X-Canvas-Token ",
    authPrefix: "Token ",
  });
  expect(saved.connection).toMatchObject({
    name: "我的云端",
    baseUrl: "https://canvas.example/canvas/comfy",
    token: "next-token",
    authHeader: "X-Canvas-Token",
    authPrefix: "Token ",
  });
  expect(saved.endpointChanged).toBe(false);
  expect(saved.authenticationChanged).toBe(true);
});

it("marks endpoint or authentication changes for a fresh connection check, without treating a name edit as one", () => {
  expect(saveConnectionDraft(current, { ...connectionDraft(current), name: "重命名" })).toMatchObject({
    endpointChanged: false,
    authenticationChanged: false,
  });
  expect(saveConnectionDraft(current, { ...connectionDraft(current), baseUrl: "https://other.example/comfy" })).toMatchObject({
    endpointChanged: true,
    authenticationChanged: false,
  });
  expect(saveConnectionDraft(current, { ...connectionDraft(current), authPrefix: "" })).toMatchObject({
    endpointChanged: false,
    authenticationChanged: true,
  });
});

it("splits pasted native addresses before rendering and retains the native key while changing tier", () => {
  const draft = updateConnectionDraft(connectionDraft(current), "baseUrl", "https://www.runninghub.cn/proxy/pasted-fixture-key");
  expect(draft).toMatchObject({ baseUrl: "https://www.runninghub.cn/proxy", token: "pasted-fixture-key", authHeader: "Authorization", authPrefix: "Bearer " });
  expect(draft.baseUrl).not.toContain("pasted-fixture-key");
  const plus = updateConnectionDraft(draft, "baseUrl", "https://www.runninghub.cn/proxy-plus");
  expect(plus.token).toBe("pasted-fixture-key");
  const replaced = updateConnectionDraft(plus, "token", "https://www.runninghub.cn/proxy/new-fixture-key");
  expect(replaced).toMatchObject({ baseUrl: "https://www.runninghub.cn/proxy", token: "new-fixture-key" });
  expect(saveConnectionDraft(current, replaced).connection.token).toBe("new-fixture-key");
});

it("keeps an AutoDL binding for cosmetic URL edits and clears it when changing the server", () => {
  const managed = { ...current, autodl: { instanceUuid: "pro-fixture" } };
  expect(saveConnectionDraft(managed, { ...connectionDraft(managed), baseUrl: current.baseUrl + "/" }).connection.autodl).toEqual(managed.autodl);
  expect(saveConnectionDraft(managed, { ...connectionDraft(managed), baseUrl: current.baseUrl.replace("canvas.example", "CANVAS.example:443") }).connection.autodl).toEqual(managed.autodl);
  expect(saveConnectionDraft(managed, { ...connectionDraft(managed), baseUrl: "https://another.example" }).connection.autodl).toBeUndefined();
  expect(managed.autodl).toEqual({ instanceUuid: "pro-fixture" });
});
