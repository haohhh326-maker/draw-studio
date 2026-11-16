import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSoftwareRelease } from "../scripts/prepare-software-release.mjs";

const run = promisify(execFile);
const folders: string[] = [];
const version = "0.1.2";
const installerUrl = "https://updates.example.test/releases/Draw-studio-0.1.2-Windows-x64-Setup.exe";
const installerName = `Draw-studio-${version}-Windows-x64-Setup.exe`;
const script = fileURLToPath(new URL("../scripts/prepare-software-release.mjs", import.meta.url));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(bytes = Buffer.from("MZsynthetic-test-installer")) {
  const root = await mkdtemp(path.join(os.tmpdir(), "software-release-test-"));
  folders.push(root);
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(root, "release", installerName), bytes);
  return { root, bytes, manifestPath: path.join(root, "release", "latest.json") };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("software release manifest", () => {
  it("hashes a multi-chunk installer and replaces the previous manifest without temporary leftovers", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x42);
    bytes.write("MZ");
    const { root, manifestPath } = await fixture(bytes);
    await writeFile(manifestPath, "previous manifest");
    const result = await prepareSoftwareRelease({ root, installerUrl, notes: "下载与画布优化\n保留项目" });
    expect(result).toEqual({ manifestPath, manifest: {
      version, notes: "下载与画布优化\n保留项目",
      windows: { url: installerUrl, sha256: sha256(bytes), size: bytes.length },
    } });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(result.manifest);
    expect((await readdir(path.join(root, "release"))).sort()).toEqual([installerName, "latest.json"].sort());
  });

  it.each([undefined, "", "invalid", "http://updates.example.test/app.exe", "https://name:private@updates.example.test/app.exe", "https://name@updates.example.test/app.exe"])(
    "rejects an invalid download URL without changing an existing release: %s", async (url) => {
      const { root, manifestPath } = await fixture();
      await writeFile(manifestPath, "previous manifest");
      await expect(prepareSoftwareRelease({ root, installerUrl: url })).rejects.toThrow(/HTTPS/);
      expect(await readFile(manifestPath, "utf8")).toBe("previous manifest");
    },
  );

  it.each([Buffer.alloc(0), Buffer.from("M"), Buffer.from("not an installer")])(
    "rejects an empty or non-Windows installer and preserves the published manifest", async bytes => {
      const { root, manifestPath } = await fixture(bytes);
      await writeFile(manifestPath, "previous manifest");
      await expect(prepareSoftwareRelease({ root, installerUrl })).rejects.toThrow(/Windows/);
      expect(await readFile(manifestPath, "utf8")).toBe("previous manifest");
      expect(await readdir(path.join(root, "release"))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
    },
  );

  it("requires the installer matching the package version", async () => {
    const { root, manifestPath } = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.3" }));
    await writeFile(manifestPath, "previous manifest");
    await expect(prepareSoftwareRelease({ root, installerUrl })).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(manifestPath, "utf8")).toBe("previous manifest");
  });

  it("cleans its temporary file when the final rename fails", async () => {
    const { root, manifestPath } = await fixture();
    await mkdir(manifestPath);
    await writeFile(path.join(manifestPath, "keep.txt"), "existing directory");
    await expect(prepareSoftwareRelease({ root, installerUrl })).rejects.toThrow();
    expect(await readFile(path.join(manifestPath, "keep.txt"), "utf8")).toBe("existing directory");
    expect((await readdir(path.join(root, "release"))).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("runs only when invoked as the CLI and never logs a signed download URL", async () => {
    const { root, manifestPath } = await fixture();
    await mkdir(path.join(root, "scripts"));
    const copiedScript = path.join(root, "scripts", "prepare-software-release.mjs");
    await copyFile(script, copiedScript);
    const imported = await run(process.execPath, ["--input-type=module", "-e", "await import('./scripts/prepare-software-release.mjs')"], { cwd: root });
    expect(imported.stdout).toBe("");
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    const { stdout, stderr } = await run(process.execPath, [copiedScript, "--installer-url", `${installerUrl}?signature=fixture-secret`, "--notes", "测试更新"]);
    expect(stdout).toContain(version);
    expect(stdout).toContain(manifestPath);
    expect(stdout + stderr).not.toMatch(/https:|signature|fixture-secret/);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).notes).toBe("测试更新");
  });

  it("fails a missing CLI URL without generating a feed", async () => {
    const { root, manifestPath } = await fixture();
    await mkdir(path.join(root, "scripts"));
    const copiedScript = path.join(root, "scripts", "prepare-software-release.mjs");
    await copyFile(script, copiedScript);
    await expect(run(process.execPath, [copiedScript])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the CLI through a directory junction or symlink", async () => {
    const { root, manifestPath } = await fixture();
    await mkdir(path.join(root, "scripts"));
    await copyFile(script, path.join(root, "scripts", "prepare-software-release.mjs"));
    const aliases = await mkdtemp(path.join(os.tmpdir(), "software-release-alias-test-"));
    folders.push(aliases);
    const alias = path.join(aliases, "project");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const { stdout } = await run(process.execPath, [path.join(alias, "scripts", "prepare-software-release.mjs"), "--installer-url", installerUrl]);
    expect(stdout).toContain(version);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).version).toBe(version);
  });
});
