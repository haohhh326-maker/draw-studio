import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWorkflowSeed, readPromptDefaults, resolveWorkflowSource } from "../scripts/prepare-desktop.mjs";

const folders: string[] = [];
async function temporary() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "desktop-prepare-test-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("public desktop build resources", () => {
  it("creates the standard empty workflow directories when the local default source is absent", async () => {
    const root = await temporary();
    const source = await resolveWorkflowSource(undefined, path.join(root, "absent-default"));
    expect(source).toBeUndefined();
    const log = vi.fn();
    await prepareWorkflowSeed(source, path.join(root, "resources"), log);
    const workflows = path.join(root, "resources", "seed", "workflows");
    const names = ["comfyui_nodes", "loras", "cloud_upload", "library", "prompt", "skills"];
    expect((await readdir(workflows)).sort()).toEqual(names.sort());
    for (const name of names) expect(await readdir(path.join(workflows, name))).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("标准空工作流目录"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("legacy app.asar"));
  });

  it("fails clearly for an explicitly configured missing directory", async () => {
    const root = await temporary();
    await expect(resolveWorkflowSource(path.join(root, "missing"))).rejects.toThrow(/DRAW_STUDIO_WORKFLOW_SOURCE.*不存在/);
    await expect(resolveWorkflowSource("")).rejects.toThrow(/DRAW_STUDIO_WORKFLOW_SOURCE/);
  });

  it.skipIf(process.platform !== "win32")("checks an explicit source before running any build steps", async () => {
    const root = await temporary();
    const script = fileURLToPath(new URL("../scripts/prepare-desktop.mjs", import.meta.url));
    const run = promisify(execFile);
    await expect(run(process.execPath, [script], {
      env: { ...process.env, DRAW_STUDIO_WORKFLOW_SOURCE: path.join(root, "missing") },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/DRAW_STUDIO_WORKFLOW_SOURCE.*不存在/) });
  });

  it("rejects a file used as the workflow source", async () => {
    const root = await temporary();
    const file = path.join(root, "workflow.json");
    await writeFile(file, "{}");
    await expect(resolveWorkflowSource(file)).rejects.toThrow(/不是目录/);
  });

  it("preserves all workflow folders and the optional legacy reader when the source exists", async () => {
    const root = await temporary();
    const source = path.join(root, "original", "workflows");
    await mkdir(path.join(source, "library", "nested"), { recursive: true });
    await mkdir(path.join(source, "custom", "empty"), { recursive: true });
    await mkdir(path.join(root, "original", "resources"));
    const workflow = Buffer.from([0, 1, 2, 128, 255]);
    const legacy = Buffer.from("synthetic legacy archive");
    await writeFile(path.join(source, "library", "nested", "workflow.json"), workflow);
    await writeFile(path.join(root, "original", "resources", "app.asar"), legacy);
    expect(await resolveWorkflowSource(undefined, source)).toBe(source);
    expect(await resolveWorkflowSource(source)).toBe(source);
    const resources = path.join(root, "output"), log = vi.fn();
    await prepareWorkflowSeed(source, resources, log);
    expect(await readFile(path.join(resources, "seed", "workflows", "library", "nested", "workflow.json"))).toEqual(workflow);
    expect(await readdir(path.join(resources, "seed", "workflows", "custom", "empty"))).toEqual([]);
    expect(await readFile(path.join(resources, "seed", "resources", "app.asar"))).toEqual(legacy);
    expect(await readFile(path.join(source, "library", "nested", "workflow.json"))).toEqual(workflow);
    expect(log).not.toHaveBeenCalled();
  });

  it("copies workflows successfully without a legacy app.asar and reports the omission", async () => {
    const root = await temporary();
    const source = path.join(root, "workflows");
    await mkdir(source);
    await writeFile(path.join(source, "custom.json"), "workflow fixture");
    const resources = path.join(root, "output"), log = vi.fn();
    await prepareWorkflowSeed(source, resources, log);
    expect(await readFile(path.join(resources, "seed", "workflows", "custom.json"), "utf8")).toBe("workflow fixture");
    expect(await readdir(path.join(resources, "seed", "resources"))).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("legacy app.asar"));
  });

  it("uses runtime defaults when the private prompt settings file is absent", async () => {
    const root = await temporary();
    expect(await readPromptDefaults(path.join(root, "prompt-optimization.settings.json"))).toEqual({});
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps saved prompt defaults but strips the local skill directory without modifying the source", async () => {
    const root = await temporary(), file = path.join(root, "prompt-optimization.settings.json");
    const settings = { language: "zh", maxTokens: 10000, skillDirectory: "C:/private/skills" };
    await writeFile(file, JSON.stringify(settings));
    expect(await readPromptDefaults(file)).toEqual({ language: "zh", maxTokens: 10000 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });

  it("does not silently discard malformed private prompt settings", async () => {
    const root = await temporary(), file = path.join(root, "prompt-optimization.settings.json");
    await writeFile(file, "{invalid");
    await expect(readPromptDefaults(file)).rejects.toThrow();
  });
});
