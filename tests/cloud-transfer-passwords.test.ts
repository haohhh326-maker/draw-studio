import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCloudTransferPasswordStore, windowsPasswordProtector, type CloudTransferPasswordStore } from "../scripts/cloud-transfer-passwords";
import { CloudFileTransferService, type NativeTransferConnection } from "../scripts/cloud-file-transfer";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("canvas-password-test-")) throw new Error("Invalid fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
const identity = { host: "cloud.example.test", port: 2222, username: "root" };
const secret = "synthetic-密码-🔑-do-not-log";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-password-test-")); roots.push(root);
  const file = path.join(root, "passwords.json");
  const protect = vi.fn(async (operation: "protect" | "unprotect", value: string) => operation === "protect" ? "fixture:" + Buffer.from(value).toString("base64") : Buffer.from(value.slice(8), "base64").toString());
  return { file, root, protect, store: createCloudTransferPasswordStore({ file, protect }) };
}
function native(): NativeTransferConnection {
  return { home: "/root", hostKey: "verified-key", fingerprint: "SHA256:fixture", list: async () => [], stat: async () => ({ directory: true, size: 0 }), mkdir: async () => undefined, upload: async () => undefined, close: vi.fn(async () => undefined) };
}
function service(store: CloudTransferPasswordStore, connection = native()) {
  const connect = vi.fn(async () => connection);
  return { connect, connection, transfer: new CloudFileTransferService({ passwordStore: store, connect }) };
}

describe("local encrypted SFTP password persistence", () => {
  it("survives a new store instance without persisting plaintext or mixing accounts", async () => {
    const { file, store, protect } = await fixture();
    await store.save(identity, secret);
    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain(secret); expect(contents).not.toContain(identity.host);
    const reopened = createCloudTransferPasswordStore({ file, protect });
    expect(await reopened.read({ ...identity, host: identity.host.toUpperCase() })).toBe(secret);
    expect(await reopened.has({ ...identity, port: 22 })).toBe(false);
    expect(await reopened.read({ ...identity, username: "other" })).toBeUndefined();
    await reopened.forget(identity); expect(await store.has(identity)).toBe(false);
  });
  it("serializes concurrent writes and clears only the selected profile", async () => {
    const { store } = await fixture(), other = { ...identity, port: 22 };
    await Promise.all([store.save(identity, secret), store.save(other, "other-fixture")]);
    await store.forget(identity); expect(await store.read(other)).toBe("other-fixture");
  });
  it("saves only after successful authentication and verified host fingerprint", async () => {
    const { store } = await fixture(), { transfer, connect } = service(store);
    await expect(transfer.connect({ ...identity, password: secret, rememberPassword: true })).rejects.toMatchObject({ code: "HOST_KEY_REQUIRED" });
    expect(await store.has(identity)).toBe(false);
    connect.mockResolvedValueOnce(native());
    const result = await transfer.connect({ ...identity, password: secret, hostKey: "verified-key", rememberPassword: true });
    expect(result.passwordSaved).toBe(true); expect(JSON.stringify(result)).not.toContain(secret);
    await transfer.close();
    const next = service(store);
    const restored = await next.transfer.connect({ ...identity, hostKey: "verified-key", useSavedPassword: true });
    expect(next.connect.mock.calls[0][0]).toMatchObject({ password: secret });
    expect(restored.passwordSaved).toBe(true);
    expect(await next.transfer.passwordStatus(identity)).toEqual({ saved: true });
    expect(JSON.stringify(await next.transfer.forgetPassword(identity))).not.toContain(secret);
    await next.transfer.close();
  });
  it("does not save a rejected authentication or expose a decryption error", async () => {
    const { store } = await fixture(), first = service(store);
    first.connect.mockRejectedValueOnce(Object.assign(new Error(secret), { code: "AUTH_FAILED" }));
    await expect(first.transfer.connect({ ...identity, password: secret, hostKey: "verified-key", rememberPassword: true })).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(await store.has(identity)).toBe(false);
    const failing = service({ ...store, read: async () => { throw new Error(secret); } });
    const error = await failing.transfer.connect({ ...identity, useSavedPassword: true }).catch(value => value);
    expect(error.code).toBe("PASSWORD_STORE_FAILED"); expect(error.message).not.toContain(secret); expect(failing.connect).not.toHaveBeenCalled();
    await first.transfer.close(); await failing.transfer.close();
  });
  it("leaves a successful connection usable and reports a sanitized save failure", async () => {
    const { store } = await fixture(), current = service({ ...store, save: async () => { throw new Error(secret); } });
    const result = await current.transfer.connect({ ...identity, password: secret, rememberPassword: true, hostKey: "verified-key" });
    expect(result).toMatchObject({ passwordSaved: false, passwordWarning: expect.stringContaining("未能保存") });
    expect(JSON.stringify(result)).not.toContain(secret); expect(await current.transfer.remote({ sessionId: result.sessionId, path: "/root" })).toMatchObject({ path: "/root" });
    await current.transfer.close();
  });
  it.runIf(process.platform === "win32")("round trips Unicode through the actual Windows current-user protector", async () => {
    const encrypted = await windowsPasswordProtector("protect", secret);
    expect(encrypted).not.toContain(secret); expect(await windowsPasswordProtector("unprotect", encrypted)).toBe(secret);
  });
});
