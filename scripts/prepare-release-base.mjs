import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSoftwareRelease } from "./prepare-software-release.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), "..");
const execute = promisify(execFile);
const stateFile = ".cache/windows-release-base.json";
const stableVersion = /^\d+\.\d+\.\d+$/;
const defaultSevenZip = path.join(process.env.ProgramFiles ?? "C:/Program Files", "7-Zip", "7z.exe");

function coordinates(repository, version, releaseId) {
  if (typeof repository !== "string" || !/^[A-Za-z\d][A-Za-z\d-]{0,38}\/[A-Za-z\d_.-]{1,100}$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1])) throw new Error("Invalid release repository.");
  if (!stableVersion.test(version ?? "")) throw new Error("Invalid release version.");
  if (!/^[1-9]\d*$/.test(String(releaseId)) || !Number.isSafeInteger(Number(releaseId))) throw new Error("Invalid release_id.");
  return { repository, owner: repository.split("/")[0], version, releaseId: Number(releaseId), tag: `v${version}`,
    installerName: `Draw-studio-${version}-Windows-x64-Setup.exe` };
}

export function assertDraft(release, expected) {
  if (release?.id !== expected.releaseId || release?.tag_name !== expected.tag || release?.draft !== true
    || release?.author?.login?.toLowerCase() !== expected.owner.toLowerCase())
    throw new Error("Release ID, version, draft state or owner does not match.");
  return release;
}

export function validateBaseManifest(manifest, repository, baseVersion) {
  const expected = coordinates(repository, baseVersion, "1");
  const url = `https://github.com/${repository}/releases/download/${expected.tag}/${expected.installerName}`;
  if (manifest?.version !== baseVersion || manifest?.windows?.url !== url
    || !/^[a-f\d]{64}$/i.test(manifest.windows.sha256 ?? "")
    || !Number.isSafeInteger(manifest.windows.size) || manifest.windows.size < 2)
    throw new Error("The published base manifest does not match its repository and version.");
  return { name: expected.installerName, url, size: manifest.windows.size, sha256: manifest.windows.sha256.toLowerCase() };
}

function secureUrl(value) {
  const address = new URL(value);
  if (address.protocol !== "https:" || address.username || address.password) throw new Error("Release downloads require HTTPS.");
  return address.href;
}

export async function fileIdentity(file) {
  const info = await fs.lstat(file);
  if (!info.isFile()) throw new Error("Release resource is not a regular file.");
  const digest = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(file)) { size += bytes.length; digest.update(bytes); }
  return { size, sha256: digest.digest("hex") };
}

export async function downloadVerifiedAsset(asset, file, { fetcher = fetch, executable = false } = {}) {
  const address = secureUrl(asset.url);
  const existing = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (existing) {
    const identity = await fileIdentity(file);
    if (identity.size === asset.size && identity.sha256 === asset.sha256) {
      if (executable) {
        const handle = await fs.open(file, "r");
        try {
          const magic = Buffer.alloc(2);
          await handle.read(magic, 0, 2, 0);
          if (magic.toString("ascii") !== "MZ") throw new Error("Base release is not a Windows installer.");
        } finally { await handle.close(); }
      }
      return identity;
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    const response = await fetcher(address);
    if (!response.ok || !response.body) throw new Error(`Base release download failed (HTTP ${response.status}).`);
    if (response.url) secureUrl(response.url);
    const hash = createHash("sha256");
    const magic = Buffer.alloc(2);
    let size = 0;
    const counter = new Transform({ transform(bytes, _encoding, done) {
      if (size < 2) bytes.copy(magic, size, 0, Math.min(bytes.length, 2 - size));
      size += bytes.length;
      hash.update(bytes);
      done(null, bytes);
    } });
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(temporary, { flags: "wx" }));
    const sha256 = hash.digest("hex");
    if (size !== asset.size || sha256 !== asset.sha256) throw new Error("Base release checksum or size does not match.");
    if (executable && magic.toString("ascii") !== "MZ") throw new Error("Base release is not a Windows installer.");
    await fs.rename(temporary, file);
    return { size, sha256 };
  } finally { await fs.rm(temporary, { force: true }); }
}

async function defaultRun(command, args, { token = process.env.GH_TOKEN } = {}) {
  const environment = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  if (token) environment.GH_TOKEN = token;
  delete environment.GH_DEBUG;
  const { stdout } = await execute(command, args, { windowsHide: true, env: environment });
  return stdout;
}

function githubClient(repository, token, fetcher) {
  if (!token) throw new Error("GH_TOKEN is required for the release build.");
  return async suffix => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${suffix}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
    return response.json();
  };
}

async function buildContext({ root, repository, releaseId, fetcher, token }) {
  const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const expected = coordinates(repository, version, releaseId);
  const api = githubClient(repository, token, fetcher);
  const repo = await api("");
  if (repo?.full_name?.toLowerCase() !== repository.toLowerCase() || repo?.owner?.login?.toLowerCase() !== expected.owner.toLowerCase()
    || repo.private !== false) throw new Error("This release workflow requires its own public repository.");
  const release = assertDraft(await api(`/releases/${expected.releaseId}`), expected);
  return { expected, api, release };
}

function basePaths(root, baseVersion) {
  if (!stableVersion.test(baseVersion ?? "")) throw new Error("Invalid base_version.");
  const directory = path.join(root, ".cache", "windows-release-base", baseVersion);
  return { directory, application: path.join(directory, "application"), resources: path.join(directory, "application", "resources", "draw-studio"),
    outer: path.join(directory, "outer"), archive: path.join(directory, "outer", "app-64.7z") };
}

export async function copyBaseResources({ root, resources, browserExecutable, environmentFile, pathFile }) {
  const browserCache = path.join(root, ".cache", "playwright-release-base");
  const relativeBrowser = path.relative(browserCache, browserExecutable);
  if (path.isAbsolute(relativeBrowser) || relativeBrowser.split(path.sep).includes(".."))
    throw new Error("The Playwright executable must use the release browser cache.");
  const nativeSource = path.join(resources, "seed", ".cache", "native-filezilla-official");
  await fs.access(path.join(nativeSource, "bridge", "cloud-transfer-bridge"));
  await fs.cp(nativeSource, path.join(root, ".cache", "native-filezilla-official"), { recursive: true });
  await fs.access(path.join(resources, "browser", "chrome-win64", "chrome.exe"));
  await fs.cp(path.join(resources, "browser", "chrome-win64"), path.dirname(browserExecutable), { recursive: true });
  for (const tool of ["ffmpeg.exe", "ffprobe.exe"]) await fs.access(path.join(resources, "tools", tool));
  const defaults = path.join(resources, "prompt-optimization.defaults.json");
  await fs.copyFile(defaults, path.join(root, "prompt-optimization.settings.json"));
  const workflowSource = path.join(resources, "seed", "workflows");
  await fs.access(workflowSource);
  if (environmentFile) await fs.appendFile(environmentFile,
    `DRAW_STUDIO_WORKFLOW_SOURCE=${workflowSource}\nPLAYWRIGHT_BROWSERS_PATH=${browserCache}\n`);
  if (pathFile) await fs.appendFile(pathFile, path.join(resources, "tools") + "\n");
  return { workflowSource, browserCache };
}

export async function prepareReleaseBase({ root = projectRoot, repository = process.env.GITHUB_REPOSITORY, releaseId,
  baseVersion = "0.1.2", token = process.env.GH_TOKEN, fetcher = fetch, run = defaultRun,
  sevenZip = defaultSevenZip,
  browserExecutable, environmentFile = process.env.GITHUB_ENV, pathFile = process.env.GITHUB_PATH } = {}) {
  root = await fs.realpath(root);
  const { expected, api } = await buildContext({ root, repository, releaseId, fetcher, token });
  const base = basePaths(root, baseVersion);
  const source = await api(`/releases/tags/v${baseVersion}`);
  if (source?.tag_name !== `v${baseVersion}` || source.draft !== false) throw new Error("The resource base must be a published release.");
  const manifestUrl = `https://github.com/${repository}/releases/download/v${baseVersion}/latest.json`;
  const manifestAssets = source.assets.filter(asset => asset.name === "latest.json" && asset.state === "uploaded");
  if (manifestAssets.length !== 1 || manifestAssets[0].browser_download_url !== manifestUrl || !/^sha256:[a-f\d]{64}$/i.test(manifestAssets[0].digest ?? ""))
    throw new Error("The base release must provide a verifiable update manifest.");
  const manifestFile = path.join(base.directory, "latest.json");
  await downloadVerifiedAsset({ url: manifestUrl, size: manifestAssets[0].size, sha256: manifestAssets[0].digest.slice(7).toLowerCase() }, manifestFile, { fetcher });
  const manifest = validateBaseManifest(JSON.parse(await fs.readFile(manifestFile, "utf8")), repository, baseVersion);
  const installers = source.assets.filter(asset => asset.name === manifest.name && asset.state === "uploaded");
  if (installers.length !== 1 || installers[0].size !== manifest.size || installers[0].browser_download_url !== manifest.url
    || installers[0].digest?.toLowerCase() !== `sha256:${manifest.sha256}`) throw new Error("The base installer differs from its published manifest.");
  const installer = path.join(base.directory, manifest.name);
  await downloadVerifiedAsset(manifest, installer, { fetcher, executable: true });
  try {
    await run(sevenZip, ["e", installer, "$PLUGINSDIR/app-64.7z", `-o${base.outer}`, "-y"]);
    await fs.access(base.archive);
    await run(sevenZip, ["x", base.archive, `-o${base.application}`, "-y"]);
  } catch { throw new Error("Verified base installer extraction failed."); }
  if (!browserExecutable) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".cache", "playwright-release-base");
    browserExecutable = (await import("playwright")).chromium.executablePath();
  }
  const configured = await copyBaseResources({ root, resources: base.resources, browserExecutable, environmentFile, pathFile });
  const state = { repository, version: expected.version, releaseId: expected.releaseId, baseVersion, baseSha256: manifest.sha256 };
  await fs.writeFile(path.join(root, stateFile), JSON.stringify(state, null, 2) + "\n");
  // These two verified archives are no longer needed after their files have been staged.
  await fs.unlink(installer);
  await fs.unlink(base.archive);
  return { ...state, ...configured };
}

async function workflowFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, identity] of await workflowFiles(file, relative)) files.set(name, identity);
    else files.set(relative, await fileIdentity(file));
  }
  return files;
}

export async function verifyWorkflowResources(source, destination) {
  const before = await workflowFiles(source);
  const after = await workflowFiles(destination);
  if (before.size !== after.size) throw new Error("The rebuilt workflow file count differs from the base release.");
  for (const [name, identity] of before) {
    const copied = after.get(name);
    if (!copied || copied.size !== identity.size || copied.sha256 !== identity.sha256) throw new Error("A rebuilt workflow resource differs from the base release.");
  }
  return before.size;
}

async function readState(root) {
  const state = JSON.parse(await fs.readFile(path.join(root, stateFile), "utf8"));
  const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  coordinates(state.repository, version, state.releaseId);
  if (state.version !== version) throw new Error("The prepared resource base belongs to another version.");
  return { ...state, paths: basePaths(root, state.baseVersion) };
}

export async function finishReleaseBase({ root = projectRoot } = {}) {
  const state = await readState(root);
  const destination = path.join(root, ".desktop-package", "resources");
  await fs.cp(path.join(state.paths.resources, "licenses"), path.join(destination, "licenses"), { recursive: true, force: false, errorOnExist: false });
  const workflowCount = await verifyWorkflowResources(path.join(state.paths.resources, "seed", "workflows"), path.join(destination, "seed", "workflows"));
  return { workflowCount };
}

export async function verifyInstallerPackage({ root = projectRoot, installer, run = defaultRun, sevenZip = defaultSevenZip } = {}) {
  const cache = path.join(root, ".cache");
  await fs.mkdir(cache, { recursive: true });
  const directory = await fs.mkdtemp(path.join(cache, "release-installer-check-"));
  const archive = path.join(directory, "app-64.7z");
  const asar = path.join(directory, "app.asar");
  try {
    await run(sevenZip, ["t", installer]);
    await run(sevenZip, ["e", installer, "$PLUGINSDIR/app-64.7z", `-o${directory}`, "-y"]);
    await fs.access(archive);
    await run(sevenZip, ["t", archive]);
    await run(sevenZip, ["e", archive, "resources/app.asar", `-o${directory}`, "-y"]);
    const expected = await fileIdentity(path.join(root, "release", "win-unpacked", "resources", "app.asar"));
    const actual = await fileIdentity(asar);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error("Installer application does not match the packaged application.");
    return actual;
  } catch { throw new Error("Windows installer archive validation failed."); }
  finally {
    await fs.rm(archive, { force: true });
    await fs.rm(asar, { force: true });
    await fs.rmdir(directory);
  }
}

export async function uploadWindowsRelease({ root = projectRoot, repository = process.env.GITHUB_REPOSITORY, releaseId,
  token = process.env.GH_TOKEN, fetcher = fetch, run = defaultRun } = {}) {
  const context = await buildContext({ root, repository, releaseId, fetcher, token });
  const state = await readState(root);
  if (state.repository !== repository || state.releaseId !== context.expected.releaseId) throw new Error("Prepared resources belong to another draft.");
  const workflowCount = await verifyWorkflowResources(path.join(state.paths.resources, "seed", "workflows"),
    path.join(root, "release", "win-unpacked", "resources", "draw-studio", "seed", "workflows"));
  const installerUrl = `https://github.com/${repository}/releases/download/${context.expected.tag}/${context.expected.installerName}`;
  const prepared = await prepareSoftwareRelease({ root, installerUrl, notes: context.release.body ?? "" });
  const installerFile = path.join(root, "release", context.expected.installerName);
  await verifyInstallerPackage({ root, installer: installerFile, run });
  const indexIdentity = await fileIdentity(prepared.manifestPath);
  const files = [
    { name: context.expected.installerName, file: installerFile, size: prepared.manifest.windows.size, sha256: prepared.manifest.windows.sha256 },
    { name: "latest.json", file: prepared.manifestPath, ...indexIdentity },
  ];
  const current = assertDraft(await context.api(`/releases/${context.expected.releaseId}`), context.expected);
  const pending = files.filter(file => !current.assets.some(asset => asset.name === file.name && asset.state === "uploaded"
    && asset.size === file.size && asset.digest?.toLowerCase() === `sha256:${file.sha256}`));
  if (pending.length) {
    try { await run("gh", ["release", "upload", context.expected.tag, ...pending.map(file => file.file), "--repo", repository, "--clobber"], { token }); }
    catch { throw new Error("Windows installer upload failed. The release remains available for retry."); }
  }
  const uploaded = assertDraft(await context.api(`/releases/${context.expected.releaseId}`), context.expected);
  for (const file of files) {
    const matching = uploaded.assets.filter(asset => asset.name === file.name && asset.state === "uploaded" && asset.size === file.size
      && asset.digest?.toLowerCase() === `sha256:${file.sha256}`);
    if (matching.length !== 1) throw new Error("GitHub did not confirm the release file checksum and size.");
  }
  return { version: context.expected.version, releaseId: context.expected.releaseId, workflowCount,
    size: prepared.manifest.windows.size, sha256: prepared.manifest.windows.sha256 };
}

async function runCli() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (!["--prepare", "--finish", "--upload"].includes(mode)) throw new Error("Select --prepare, --finish or --upload.");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--base-version": "baseVersion", "--release-id": "releaseId", "--repository": "repository" }[args[index]];
    if (!key || args[index + 1] === undefined || args[index + 1].startsWith("--") || key in options) throw new Error("Invalid release build arguments.");
    options[key] = args[index + 1];
  }
  const action = { "--prepare": prepareReleaseBase, "--finish": finishReleaseBase, "--upload": uploadWindowsRelease }[mode];
  const result = await action(options);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined) === scriptFile) {
  runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
