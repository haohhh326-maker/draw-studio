import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), "..");

export async function prepareSoftwareRelease({ root = projectRoot, installerUrl, notes = "" } = {}) {
  let address;
  try { address = new URL(installerUrl); }
  catch { throw new Error("请通过 --installer-url 提供有效的 HTTPS 安装包地址。"); }
  if (address.protocol !== "https:" || address.username || address.password)
    throw new Error("安装包地址必须为 HTTPS，且不能包含账号或密码。");
  if (typeof notes !== "string") throw new Error("更新说明必须为文字。");
  const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("package.json 中的软件版本号无效。");
  const directory = path.join(root, "release");
  const installer = path.join(directory, `Draw-studio-${version}-Windows-x64-Setup.exe`);
  const handle = await fs.open(installer, "r");
  const hash = createHash("sha256");
  let size = 0;
  try {
    const info = await handle.stat();
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    if (!info.isFile() || info.size < 2 || bytesRead !== 2 || magic.toString("ascii") !== "MZ")
      throw new Error("安装包不是有效的 Windows 程序。");
    for await (const bytes of handle.createReadStream({ start: 0, autoClose: false })) {
      hash.update(bytes);
      size += bytes.length;
    }
    const after = await handle.stat();
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error("安装包在读取期间发生变化，请重新生成清单。");
  } finally { await handle.close(); }
  const manifest = { version, notes, windows: { url: address.href, sha256: hash.digest("hex"), size } };
  const manifestPath = path.join(directory, "latest.json");
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporary, manifestPath);
  } finally { await fs.rm(temporary, { force: true }); }
  return { manifest, manifestPath };
}

async function runCli() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--installer-url": "installerUrl", "--notes": "notes" }[args[index]];
    if (!key || args[index + 1] === undefined || args[index + 1].startsWith("--") || key in options)
      throw new Error("用法：node scripts/prepare-software-release.mjs --installer-url HTTPS地址 [--notes 更新说明]");
    options[key] = args[index + 1];
  }
  const { manifest, manifestPath } = await prepareSoftwareRelease(options);
  console.log(`软件版本：${manifest.version}\n本地更新清单：${manifestPath}`);
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined) === scriptFile) {
  runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
