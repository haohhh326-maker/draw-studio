import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import sharp from "sharp";
import { chromium } from "playwright";

export async function resolveWorkflowSource(configuredSource, defaultSource = "E:/123/DFCine/DFCine0.26/workflows") {
  const explicit = configuredSource !== undefined;
  if (explicit && (typeof configuredSource !== "string" || !configuredSource.trim()))
    throw new Error("DRAW_STUDIO_WORKFLOW_SOURCE 必须指向存在的工作流目录。");
  const source = path.resolve(explicit ? configuredSource : defaultSource);
  const info = await fs.stat(source).catch(error => {
    if (error.code !== "ENOENT") throw error;
    if (explicit) throw new Error("DRAW_STUDIO_WORKFLOW_SOURCE 指定的工作流目录不存在：" + source);
  });
  if (info && !info.isDirectory()) throw new Error("工作流来源不是目录：" + source);
  return info ? source : undefined;
}

export async function prepareWorkflowSeed(source, resources, log = console.log) {
  const destination = path.join(resources, "seed", "workflows");
  if (source) await fs.cp(source, destination, { recursive: true });
  else log("未检测到默认工作流目录，本次安装包将包含标准空工作流目录。");
  for (const name of ["comfyui_nodes", "loras", "cloud_upload", "library", "prompt", "skills"])
    await fs.mkdir(path.join(destination, name), { recursive: true });
  const legacyDestination = path.join(resources, "seed", "resources");
  await fs.mkdir(legacyDestination, { recursive: true });
  const legacySource = source && path.resolve(source, "..", "resources", "app.asar");
  const legacy = legacySource && await fs.stat(legacySource).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (legacy) await fs.copyFile(legacySource, path.join(legacyDestination, "app.asar"));
  else log("未检测到可选的 legacy app.asar，本次安装包不包含该组件。");
}

export async function readPromptDefaults(file) {
  const text = await fs.readFile(file, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "{}";
  });
  const defaults = JSON.parse(text);
  delete defaults.skillDirectory;
  return defaults;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const staging = path.join(root, ".desktop-package");
  const application = path.join(staging, "app");
  const resources = path.join(staging, "resources");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (process.platform !== "win32") throw new Error("此安装包构建目标为 Windows。");
  const source = await resolveWorkflowSource(process.env.DRAW_STUDIO_WORKFLOW_SOURCE);
  const resolvedRoot = await fs.realpath(root);
  const stagingTarget = path.join(await fs.realpath(path.dirname(staging)), path.basename(staging));
  if (stagingTarget !== path.join(resolvedRoot, ".desktop-package")) throw new Error("桌面构建暂存目录超出项目目录。");
  if ((await fs.lstat(staging).catch(() => undefined))?.isSymbolicLink()) throw new Error("桌面构建暂存目录不能是文件链接。");
  await fs.rm(stagingTarget, { recursive: true, force: true });
  await fs.mkdir(application, { recursive: true });
  await fs.mkdir(resources, { recursive: true });
  const updateSettings = await fs.readFile(path.join(root, "build", "desktop", "software-update.json"), "utf8")
    .catch(error => { if (error.code !== "ENOENT") throw error; });
  if (updateSettings) {
    const { feedUrl } = JSON.parse(updateSettings);
    const feed = new URL(feedUrl);
    if (feed.protocol !== "https:" || feed.username || feed.password) throw new Error("软件更新地址必须为 HTTPS。");
    await fs.writeFile(path.join(resources, "software-update.defaults.json"), JSON.stringify({ feedUrl: feed.href }, null, 2));
  }

  await build({
    entryPoints: [path.join(root, "scripts", "desktop-server.ts")],
    outfile: path.join(resources, "desktop-server.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["playwright", "sharp", "ws", "form-data", "node-fetch"],
    define: { "import.meta.url": "__filename_url", "import.meta.env.BASE_URL": JSON.stringify("/") },
    banner: { js: 'const __filename_url = require("node:url").pathToFileURL(__filename).href;' },
  });
  for (const name of ["desktop-host.cjs", "desktop-preload.cjs", "desktop-workspace.cjs", "desktop-updates.cjs"])
    await fs.copyFile(path.join(root, "scripts", name), path.join(application, name));
  const runtimeDependencies = {};
  for (const name of ["playwright", "sharp", "ws", "form-data", "node-fetch"]) {
    const installed = JSON.parse(await fs.readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    runtimeDependencies[name] = installed.version;
  }
  await fs.writeFile(path.join(application, "package.json"), JSON.stringify({
    name: "draw-studio", productName: "Draw studio", version: pkg.version, main: "desktop-host.cjs",
    description: "Draw studio 无限画布", author: "Draw studio", private: true,
    dependencies: runtimeDependencies,
  }, null, 2));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("请通过 npm run desktop:prepare 准备安装资源。");
  const installed = spawnSync(process.execPath, [npm, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: application, stdio: "inherit", windowsHide: true,
  });
  if (installed.status !== 0) throw new Error("桌面运行依赖安装失败。");
  // The standalone server resolves its native/external modules beside its bundle.
  await fs.cp(path.join(application, "node_modules"), path.join(resources, "node_modules"), { recursive: true });
  const frontend = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"),
    "build", "--outDir", path.join(resources, "dist"), "--emptyOutDir"], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
  if (frontend.status !== 0) throw new Error("桌面界面构建失败。");
  await prepareWorkflowSeed(source, resources);
  const defaults = await readPromptDefaults(path.join(root, "prompt-optimization.settings.json"));
  await fs.writeFile(path.join(resources, "prompt-optimization.defaults.json"), JSON.stringify(defaults, null, 2));

  const nativeBase = path.join(root, ".cache", "native-filezilla-official");
  const nativeDestination = path.join(resources, "seed", ".cache", "native-filezilla-official");
  await fs.mkdir(path.join(nativeDestination, "bridge"), { recursive: true });
  await fs.copyFile(path.join(nativeBase, "bridge", "cloud-transfer-bridge"), path.join(nativeDestination, "bridge", "cloud-transfer-bridge"));
  const libraryDirectory = path.join(nativeBase, "prefix", "lib");
  const libraries = await fs.readdir(libraryDirectory);
  const libraryTarget = path.join(nativeDestination, "prefix", "lib");
  await fs.mkdir(libraryTarget, { recursive: true });
  for (const name of libraries.filter(name => name.includes(".so"))) {
    let actual = path.join(libraryDirectory, name);
    if ((await fs.stat(actual)).size === 0) {
      const prefix = name.split(".so")[0] + ".so";
      const candidates = libraries.filter(candidate => candidate.startsWith(prefix));
      const sizes = await Promise.all(candidates.map(async candidate => ({ name: candidate, size: (await fs.stat(path.join(libraryDirectory, candidate))).size })));
      const full = sizes.sort((left, right) => right.size - left.size)[0];
      if (!full?.size) throw new Error("缺少 FileZilla 动态库 " + name);
      actual = path.join(libraryDirectory, full.name);
    }
    await fs.copyFile(actual, path.join(libraryTarget, name));
  }

  const tools = path.join(resources, "tools");
  await fs.mkdir(tools, { recursive: true });
  await fs.mkdir(path.join(resources, "licenses"), { recursive: true });
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const executable = execFileSync("where.exe", [tool], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
    await fs.copyFile(executable, path.join(tools, tool + ".exe"));
    if (tool === "ffmpeg") {
      const parent = path.resolve(executable, "..", "..");
      for (const file of (await fs.readdir(parent)).filter(name => /^(LICENSE|COPYING)/i.test(name)))
        if ((await fs.stat(path.join(parent, file))).isFile())
          await fs.copyFile(path.join(parent, file), path.join(resources, "licenses", "FFmpeg-" + file));
    }
  }
  const chromeDirectory = path.dirname(chromium.executablePath());
  await fs.access(path.join(chromeDirectory, "chrome.exe"));
  await fs.cp(chromeDirectory, path.join(resources, "browser", "chrome-win64"), { recursive: true });
  await fs.mkdir(path.join(resources, "licenses"), { recursive: true });
  await fs.cp(path.join(root, "licenses"), path.join(resources, "licenses"), { recursive: true });
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await fs.copyFile(path.join(root, file), path.join(resources, "licenses", file));
  await fs.cp(path.join(root, "vendor", "aifisher"), path.join(resources, "licenses", "aifisher-source"), { recursive: true });
  await fs.cp(path.join(root, "native", "cloud-transfer"), path.join(resources, "licenses", "cloud-transfer-source"), { recursive: true });
  await fs.writeFile(path.join(resources, "licenses", "BUNDLED-COMPONENTS.txt"),
    "Electron https://github.com/electron/electron\nChromium https://chromium.googlesource.com/chromium/src\n" +
    "Playwright https://github.com/microsoft/playwright\nsharp https://github.com/lovell/sharp\n" +
    "FFmpeg GPL build by Gyan https://www.gyan.dev/ffmpeg/builds/ ; corresponding source https://ffmpeg.org/releases/\n" +
    "FileZilla/libfilezilla/fzSSH source and build scripts are supplied in cloud-transfer-source.\n" +
    "AIFISHER source is supplied in aifisher-source.\n");
  const iconSource = path.join(root, "build", "desktop", "icon-source.png");
  await sharp(iconSource).resize(1024, 1024).png().toFile(path.join(resources, "icon.png"));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(size => sharp(iconSource).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    header[entry] = sizes[index] === 256 ? 0 : sizes[index]; header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += pngs[index].length;
  }
  await fs.writeFile(path.join(root, "build", "desktop", "icon.ico"), Buffer.concat([header, ...pngs]));
  console.log("桌面应用、工作流目录、本机服务、浏览器与媒体组件已准备完成。");
}
