// Seed resources include an opaque legacy reader archive. Electron's patched
// fs treats .asar as a virtual directory, so installation copies use raw fs.
const fs = process.versions.electron ? require("original-fs").promises : require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");

async function copyMissing(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyMissing(from, to);
    else if (entry.isFile()) {
      try { await fs.copyFile(from, to, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } else throw new Error("安装资源包含不支持的文件链接。" );
  }
}

async function writeInitial(file, value) {
  try { await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

async function prepareWorkspace(resources, userData) {
  const workspace = path.join(userData, "workspace");
  await copyMissing(path.join(resources, "seed"), workspace);
  for (const name of ["cloud_upload", "comfyui_nodes", "input", "library", "loras", "mac", "mcp", "prompt", "skills", "stage-production", "text-node-presets"])
    await fs.mkdir(path.join(workspace, "workflows", name), { recursive: true });
  await writeInitial(path.join(workspace, "workflow-library.settings.json"), {
    sourcePath: path.join(workspace, "workflows", "library"),
  });
  const defaults = JSON.parse(await fs.readFile(path.join(resources, "prompt-optimization.defaults.json"), "utf8"));
  await writeInitial(path.join(workspace, "prompt-optimization.settings.json"), {
    ...defaults, skillDirectory: path.join(workspace, "workflows", "prompt"),
  });
  return workspace;
}

module.exports = { copyMissing, prepareWorkspace };
