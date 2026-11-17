import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDraft, copyBaseResources, downloadVerifiedAsset, fileIdentity, finishReleaseBase, prepareReleaseBase,
  uploadWindowsRelease, validateBaseManifest, verifyInstallerPackage, verifyWorkflowResources } from "../scripts/prepare-release-base.mjs";
import { prepareSoftwareRelease } from "../scripts/prepare-software-release.mjs";

const repository = "haohhh326-maker/draw-studio";
const owner = "haohhh326-maker";
const releaseId = 123456;
const version = "0.1.3";
const baseVersion = "0.1.2";
const token = "fixture-token-that-must-not-be-logged";
const installerName = `Draw-studio-${baseVersion}-Windows-x64-Setup.exe`;
const baseUrl = `https://github.com/${repository}/releases/download/v${baseVersion}`;
const api = `https://api.github.com/repos/${repository}`;
const bytes = Buffer.from("MZsynthetic-release-base-installer");
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const baseManifest = () => ({ version: baseVersion, windows: { url: `${baseUrl}/${installerName}`, size: bytes.length, sha256: hash(bytes) } });
const folders: string[] = [];

async function temporary() {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "canvas-release-base-test-"));
  folders.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

async function put(file: string, value: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

function archiveFixtureRun(root: string) {
  return async (_command: string, args: string[], _options?: { token?: string }) => {
    if (args[0] === "t") return "";
    const directory = args.find(value => value.startsWith("-o"))?.slice(2);
    if (args[0] !== "e" || !directory) throw new Error("Unexpected archive fixture command");
    if (args[2] === "$PLUGINSDIR/app-64.7z") await put(path.join(directory, "app-64.7z"), "fixture-inner-archive");
    else if (args[2] === "resources/app.asar") await cp(path.join(root, "release/win-unpacked/resources/app.asar"), path.join(directory, "app.asar"));
    else throw new Error("Unexpected archive fixture member");
    return "";
  };
}

async function resourceFixture(root: string) {
  const resources = path.join(root, ".cache", "windows-release-base", baseVersion, "application", "resources", "draw-studio");
  await put(path.join(resources, "seed", ".cache", "native-filezilla-official", "bridge", "cloud-transfer-bridge"), "base-native-engine");
  await put(path.join(resources, "seed", ".cache", "native-filezilla-official", "prefix", "lib", "native.so"), "base-library");
  await put(path.join(resources, "seed", "workflows", "library", "workflow.json"), "workflow-one");
  await put(path.join(resources, "seed", "workflows", "prompt", "SKILL.md"), "workflow-two");
  await put(path.join(resources, "seed", "resources", "app.asar"), "base-legacy-reader");
  await put(path.join(resources, "browser", "chrome-win64", "chrome.exe"), "MZbase-browser");
  await put(path.join(resources, "browser", "chrome-win64", "LICENSE"), "browser-license");
  await put(path.join(resources, "tools", "ffmpeg.exe"), "MZbase-ffmpeg");
  await put(path.join(resources, "tools", "ffprobe.exe"), "MZbase-ffprobe");
  await put(path.join(resources, "licenses", "LICENSE"), "old-source-license");
  await put(path.join(resources, "licenses", "FFmpeg-LICENSE.txt"), "base-ffmpeg-license");
  await put(path.join(resources, "prompt-optimization.defaults.json"), JSON.stringify({ language: "zh", maxTokens: 10000 }));
  return resources;
}

function draft() {
  return { id: releaseId, tag_name: `v${version}`, draft: true, author: { login: owner }, body: "Show update download progress", assets: [] as object[] };
}

function metadataFixture(target = draft()) {
  const manifestBytes = Buffer.from(JSON.stringify(baseManifest()));
  const published = {
    tag_name: `v${baseVersion}`, draft: false, assets: [
      { name: "latest.json", state: "uploaded", browser_download_url: `${baseUrl}/latest.json`, size: manifestBytes.length, digest: `sha256:${hash(manifestBytes)}` },
      { name: installerName, state: "uploaded", browser_download_url: `${baseUrl}/${installerName}`, size: bytes.length, digest: `sha256:${hash(bytes)}` },
    ],
  };
  const repo = { full_name: repository, private: false, owner: { login: owner } };
  const fetcher = vi.fn(async (address: string, _options?: RequestInit) => {
    if (address === api) return Response.json(repo);
    if (address === `${api}/releases/${releaseId}`) return Response.json(target);
    if (address === `${api}/releases/tags/v${baseVersion}`) return Response.json(published);
    if (address === `${baseUrl}/latest.json`) return new Response(manifestBytes);
    if (address === `${baseUrl}/${installerName}`) return new Response(bytes);
    throw new Error("Unexpected fixture address");
  });
  return { target, published, repo, fetcher };
}

afterEach(async () => {
  const parent = await realpath(os.tmpdir());
  for (const folder of folders.splice(0)) {
    const resolved = await realpath(folder);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("canvas-release-base-test-"))
      throw new Error("Refusing to remove an unrelated fixture.");
    await rm(resolved, { recursive: true, force: true });
  }
});

describe("published Windows resource base", () => {
  it("binds the base manifest to the same repository and exact release", () => {
    expect(validateBaseManifest(baseManifest(), repository, baseVersion)).toEqual({ name: installerName, url: `${baseUrl}/${installerName}`, size: bytes.length, sha256: hash(bytes) });
    expect(() => validateBaseManifest({ ...baseManifest(), version }, repository, baseVersion)).toThrow("manifest");
    expect(() => validateBaseManifest({ ...baseManifest(), windows: { ...baseManifest().windows, url: "https://other.example/setup.exe" } }, repository, baseVersion)).toThrow("manifest");
    expect(() => validateBaseManifest({ ...baseManifest(), windows: { ...baseManifest().windows, size: 0 } }, repository, baseVersion)).toThrow("manifest");
  });

  it.each([
    { id: releaseId + 1 }, { tag_name: "v0.1.4" }, { draft: false }, { author: { login: "another-owner" } },
  ])("rejects a different target draft %#", change => {
    expect(() => assertDraft({ ...draft(), ...change }, { releaseId, tag: `v${version}`, owner })).toThrow("does not match");
  });

  it("verifies streamed bytes and reuses a verified executable", async () => {
    const root = await temporary();
    const file = path.join(root, "installer.exe");
    const fetcher = vi.fn(async () => new Response(bytes));
    const asset = { url: `${baseUrl}/${installerName}`, size: bytes.length, sha256: hash(bytes) };
    await downloadVerifiedAsset(asset, file, { fetcher, executable: true });
    expect(await readFile(file)).toEqual(bytes);
    await downloadVerifiedAsset(asset, file, { fetcher, executable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["sha256", "size", "format"])("rejects incorrect %s before giving an installer its final name", async invalid => {
    const root = await temporary();
    const file = path.join(root, "installer.exe");
    const body = invalid === "format" ? Buffer.from("not-an-executable") : bytes;
    const asset = { url: `${baseUrl}/${installerName}`, size: body.length + (invalid === "size" ? 1 : 0), sha256: invalid === "sha256" ? "0".repeat(64) : hash(body) };
    await expect(downloadVerifiedAsset(asset, file, { fetcher: async () => new Response(body), executable: true })).rejects.toThrow();
    expect((await readdir(root)).filter(name => name.includes("installer.exe"))).toEqual([]);
  });

  it("also checks the MZ header of a hash-matching cached base", async () => {
    const root = await temporary();
    const body = Buffer.from("not-an-executable");
    const file = path.join(root, "installer.exe");
    await writeFile(file, body);
    await expect(downloadVerifiedAsset({ url: `${baseUrl}/${installerName}`, size: body.length, sha256: hash(body) }, file,
      { fetcher: vi.fn(), executable: true })).rejects.toThrow("Windows installer");
  });

  it("keeps an existing cache file when a replacement stream fails and removes the partial", async () => {
    const root = await temporary();
    const file = path.join(root, "installer.exe");
    await writeFile(file, "previous-cache");
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.error(new Error("fixture interrupted"));
    } });
    await expect(downloadVerifiedAsset({ url: `${baseUrl}/${installerName}`, size: bytes.length, sha256: hash(bytes) }, file,
      { fetcher: async () => new Response(stream), executable: true })).rejects.toThrow("interrupted");
    expect(await readFile(file, "utf8")).toBe("previous-cache");
    expect((await readdir(root)).filter(name => name.endsWith(".partial"))).toEqual([]);
  });

  it("rejects HTTP redirects before using their bytes", async () => {
    const root = await temporary();
    const response = new Response(bytes);
    Object.defineProperty(response, "url", { value: "http://downgrade.example/setup.exe" });
    await expect(downloadVerifiedAsset({ url: `${baseUrl}/${installerName}`, size: bytes.length, sha256: hash(bytes) }, path.join(root, "installer.exe"),
      { fetcher: async () => response })).rejects.toThrow("HTTPS");
  });

  it("stages only resources and exports paths for the existing prepare script", async () => {
    const root = await temporary();
    const resources = await resourceFixture(root);
    const browserExecutable = path.join(root, ".cache", "playwright-release-base", "chromium-fixture", "chrome-win64", "chrome.exe");
    const environmentFile = path.join(root, "github-env");
    const pathFile = path.join(root, "github-path");
    const configured = await copyBaseResources({ root, resources, browserExecutable, environmentFile, pathFile });
    expect(await readFile(path.join(root, ".cache/native-filezilla-official/bridge/cloud-transfer-bridge"), "utf8")).toBe("base-native-engine");
    expect(await readFile(browserExecutable, "utf8")).toBe("MZbase-browser");
    expect(JSON.parse(await readFile(path.join(root, "prompt-optimization.settings.json"), "utf8"))).toEqual({ language: "zh", maxTokens: 10000 });
    expect(await readFile(environmentFile, "utf8")).toContain(`DRAW_STUDIO_WORKFLOW_SOURCE=${configured.workflowSource}`);
    expect(await readFile(pathFile, "utf8")).toBe(path.join(resources, "tools") + "\n");
    expect(await readFile(path.join(configured.workflowSource, "..", "resources", "app.asar"), "utf8")).toBe("base-legacy-reader");
  });

  it("refuses a browser destination outside the release cache", async () => {
    const root = await temporary();
    await expect(copyBaseResources({ root, resources: await resourceFixture(root), browserExecutable: path.join(root, "outside", "chrome.exe") })).rejects.toThrow("browser cache");
  });

  it("prepares a published, checksum-verified base with literal 7z archive arguments", async () => {
    const root = await temporary();
    const fixture = metadataFixture();
    const browserExecutable = path.join(root, ".cache/playwright-release-base/chromium-fixture/chrome-win64/chrome.exe");
    const run = vi.fn(async (_command: string, args: string[]) => {
      const directory = args.find(argument => argument.startsWith("-o"))!.slice(2);
      if (args[0] === "e") await put(path.join(directory, "app-64.7z"), "fixture-nested-archive");
      else await resourceFixture(root);
      return "";
    });
    const prepared = await prepareReleaseBase({ root, repository, releaseId, baseVersion, token, fetcher: fixture.fetcher, run, browserExecutable });
    expect(prepared.version).toBe(version);
    expect(run.mock.calls[0][1][2]).toBe("$PLUGINSDIR/app-64.7z");
    expect(run.mock.calls[1][1][0]).toBe("x");
    expect(JSON.parse(await readFile(path.join(root, ".cache/windows-release-base.json"), "utf8"))).toMatchObject({ repository, version, releaseId, baseVersion, baseSha256: hash(bytes) });
    await expect(access(path.join(root, ".cache/windows-release-base", baseVersion, installerName))).rejects.toMatchObject({ code: "ENOENT" });
    const downloads = fixture.fetcher.mock.calls.filter(([address]) => address.startsWith(baseUrl));
    expect(downloads.every(([, options]) => !options?.headers)).toBe(true);
  });

  it.each(["private", "target", "base", "digest"])("stops before extraction when %s metadata is invalid", async invalid => {
    const root = await temporary();
    const fixture = metadataFixture();
    if (invalid === "private") fixture.repo.private = true;
    if (invalid === "target") fixture.target.draft = false;
    if (invalid === "base") fixture.published.draft = true;
    if (invalid === "digest") fixture.published.assets[1].digest = `sha256:${"0".repeat(64)}`;
    const run = vi.fn();
    await expect(prepareReleaseBase({ root, repository, releaseId, baseVersion, token, fetcher: fixture.fetcher, run,
      browserExecutable: path.join(root, ".cache/playwright-release-base/chromium-fixture/chrome-win64/chrome.exe") })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("fills only missing licenses and checks every staged workflow byte", async () => {
    const root = await temporary();
    const resources = await resourceFixture(root);
    await put(path.join(root, ".cache/windows-release-base.json"), JSON.stringify({ repository, version, releaseId, baseVersion }));
    const staged = path.join(root, ".desktop-package/resources");
    await cp(path.join(resources, "seed/workflows"), path.join(staged, "seed/workflows"), { recursive: true });
    await put(path.join(staged, "licenses/LICENSE"), "current-source-license");
    expect(await finishReleaseBase({ root })).toEqual({ workflowCount: 2 });
    expect(await readFile(path.join(staged, "licenses/LICENSE"), "utf8")).toBe("current-source-license");
    expect(await readFile(path.join(staged, "licenses/FFmpeg-LICENSE.txt"), "utf8")).toBe("base-ffmpeg-license");
    await writeFile(path.join(staged, "seed/workflows/library/workflow.json"), "changed");
    await expect(finishReleaseBase({ root })).rejects.toThrow("differs");
  });

  it("rejects missing or extra workflow resources", async () => {
    const root = await temporary();
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    await put(path.join(source, "one.json"), "one");
    await put(path.join(destination, "one.json"), "one");
    await put(path.join(destination, "extra.json"), "extra");
    await expect(verifyWorkflowResources(source, destination)).rejects.toThrow("count");
  });
});

describe("draft Windows release uploads", () => {
  async function uploadFixture() {
    const root = await temporary();
    const resources = await resourceFixture(root);
    await put(path.join(root, ".cache/windows-release-base.json"), JSON.stringify({ repository, version, releaseId, baseVersion }));
    await cp(path.join(resources, "seed/workflows"), path.join(root, "release/win-unpacked/resources/draw-studio/seed/workflows"), { recursive: true });
    const finalName = `Draw-studio-${version}-Windows-x64-Setup.exe`;
    const file = path.join(root, "release", finalName);
    await put(file, bytes);
    await put(path.join(root, "release/win-unpacked/resources/app.asar"), "current-built-application");
    const fixture = metadataFixture();
    async function uploadedAssets() {
      return Promise.all([file, path.join(root, "release/latest.json")].map(async assetFile => {
        const identity = await fileIdentity(assetFile);
        return { name: path.basename(assetFile), state: "uploaded", size: identity.size, digest: `sha256:${identity.sha256}` };
      }));
    }
    const verify = archiveFixtureRun(root);
    const run = vi.fn(async (command: string, args: string[], options?: { token?: string }) => {
      if (command !== "gh") return verify(command, args, options);
      fixture.target.assets = await uploadedAssets();
      return "";
    });
    return { root, file, finalName, fixture, run, uploadedAssets };
  }

  it("generates a manifest with the shared helper and confirms both remote checksums", async () => {
    const context = await uploadFixture();
    const result = await uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run });
    expect(result).toMatchObject({ version, releaseId, workflowCount: 2, size: bytes.length, sha256: hash(bytes) });
    const manifest = JSON.parse(await readFile(path.join(context.root, "release/latest.json"), "utf8"));
    expect(manifest.notes).toBe(context.fixture.target.body);
    expect(manifest.windows).toMatchObject({ url: `https://github.com/${repository}/releases/download/v${version}/${context.finalName}`, sha256: hash(bytes), size: bytes.length });
    const args = context.run.mock.calls.find(([command]) => command === "gh")![1];
    expect(args).toEqual(["release", "upload", `v${version}`, context.file, path.join(context.root, "release/latest.json"), "--repo", repository, "--clobber"]);
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("reuses matching completed remote assets without clobbering them", async () => {
    const context = await uploadFixture();
    await prepareSoftwareRelease({ root: context.root, installerUrl: `https://github.com/${repository}/releases/download/v${version}/${context.finalName}`, notes: context.fixture.target.body });
    context.fixture.target.assets = await context.uploadedAssets();
    await uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run });
    expect(context.run.mock.calls.filter(([command]) => command === "gh")).toHaveLength(0);
  });

  it("fails after an upload whose server digest differs", async () => {
    const context = await uploadFixture();
    const verify = archiveFixtureRun(context.root);
    context.run.mockImplementation(async (command, args, options) => {
      if (command !== "gh") return verify(command, args, options);
      context.fixture.target.assets = await context.uploadedAssets();
      Object.assign(context.fixture.target.assets[0], { digest: `sha256:${"0".repeat(64)}` });
      return "";
    });
    await expect(uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run })).rejects.toThrow("checksum");
  });

  it("rechecks draft state before uploading", async () => {
    const context = await uploadFixture();
    let lookups = 0;
    const original = context.fixture.fetcher.getMockImplementation()!;
    context.fixture.fetcher.mockImplementation(async (address, options) => {
      if (address === `${api}/releases/${releaseId}` && ++lookups > 1) context.fixture.target.draft = false;
      return original(address, options);
    });
    await expect(uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run })).rejects.toThrow("draft");
    expect(context.run.mock.calls.filter(([command]) => command === "gh")).toHaveLength(0);
  });

  it("sanitizes command errors and retains the complete local installer for retry", async () => {
    const context = await uploadFixture();
    const verify = archiveFixtureRun(context.root);
    context.run.mockImplementation(async (command, args, options) => {
      if (command !== "gh") return verify(command, args, options);
      throw new Error(`Signed URL and ${token}`);
    });
    await expect(uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run })).rejects.toThrow("Windows installer upload failed");
    expect(await readFile(context.file)).toEqual(bytes);
    expect((await stat(context.file)).size).toBe(bytes.length);
  });

  it("rejects an archive failure before any upload", async () => {
    const context = await uploadFixture();
    context.run.mockRejectedValueOnce(new Error("broken installer archive"));
    await expect(uploadWindowsRelease({ root: context.root, repository, releaseId, token, fetcher: context.fixture.fetcher, run: context.run })).rejects.toThrow("archive validation failed");
    expect(context.run.mock.calls.filter(([command]) => command === "gh")).toHaveLength(0);
  });
});

describe("complete Windows installer validation", () => {
  it("tests both archives and compares the extracted application with win-unpacked", async () => {
    const root = await temporary();
    const installer = path.join(root, "release/setup.exe");
    await put(installer, bytes);
    await put(path.join(root, "release/win-unpacked/resources/app.asar"), "current-built-application");
    const run = vi.fn(archiveFixtureRun(root));
    expect(await verifyInstallerPackage({ root, installer, run })).toEqual({ size: 25, sha256: hash("current-built-application") });
    expect(run.mock.calls.map(([, args]) => [args[0], args[2]])).toEqual([
      ["t", undefined], ["e", "$PLUGINSDIR/app-64.7z"], ["t", undefined], ["e", "resources/app.asar"],
    ]);
    expect(await readdir(path.join(root, ".cache"))).toEqual([]);
  });

  it.each(["inner", "application"])("rejects a corrupt %s and removes verification copies", async invalid => {
    const root = await temporary();
    const installer = path.join(root, "release/setup.exe");
    await put(installer, bytes);
    await put(path.join(root, "release/win-unpacked/resources/app.asar"), "current-built-application");
    const verify = archiveFixtureRun(root);
    const run = vi.fn(async (command: string, args: string[]) => {
      if (invalid === "inner" && args[0] === "t" && args[1] !== installer) throw new Error("corrupt inner archive");
      const result = await verify(command, args);
      if (invalid === "application" && args[2] === "resources/app.asar")
        await writeFile(path.join(args.find(value => value.startsWith("-o"))!.slice(2), "app.asar"), "wrong application");
      return result;
    });
    await expect(verifyInstallerPackage({ root, installer, run })).rejects.toThrow("archive validation failed");
    expect(await readdir(path.join(root, ".cache"))).toEqual([]);
  });
});
