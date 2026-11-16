import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudTransferPasswordStore } from "../scripts/cloud-transfer-passwords";
import { deepSeekDataRoot } from "../scripts/deepseek-browser-service";
import { museDataRoot } from "../scripts/muse-browser-service";
import { serviceDataRoot } from "../scripts/service-data-root";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});
it("isolates desktop service profiles and encrypted passwords in the host-provided home", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "canvas-data-home-")); temporary.push(folder);
  vi.stubEnv("DRAW_STUDIO_DATA_HOME", folder);
  expect(serviceDataRoot()).toBe(folder);
  expect(museDataRoot()).toBe(path.join(folder, "muse"));
  expect(deepSeekDataRoot()).toBe(path.join(folder, "deepseek"));
  const store = createCloudTransferPasswordStore({ protect: async () => "encrypted-fixture" });
  const identity = { host: "host.test", port: 22, username: "fixture" };
  await store.save(identity, "synthetic-secret");
  const saved = await readFile(path.join(folder, "secrets", "sftp-passwords.v1.json"), "utf8");
  expect(saved).toContain("encrypted-fixture");
  expect(saved).not.toContain("synthetic-secret");
});
it("keeps the existing developer data locations when the host override is absent", () => {
  vi.stubEnv("DRAW_STUDIO_DATA_HOME", "");
  const expected = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "DrawStudio");
  expect(serviceDataRoot()).toBe(expected);
  expect(museDataRoot()).toBe(path.join(expected, "muse"));
  expect(deepSeekDataRoot()).toBe(path.join(expected, "deepseek"));
});
