import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents:
      'export { catalog } from "./src/workflow/catalog.ts"; export { selectWorkflowOutput, workflowAvailability } from "./src/workflow/mirror.ts";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { catalog, selectWorkflowOutput, workflowAvailability } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const directory = resolve(root, "deploy/autodl/recipes");
await mkdir(directory, { recursive: true });
const entries = [];
const unavailable = [];
for (const definition of catalog) {
  const w = selectWorkflowOutput(definition, {});
  if (!w.template || w.source?.issues.length) {
    unavailable.push({
      id: w.id,
      name: w.name,
      source: w.source?.file,
      issues: w.source?.issues ?? ["No API graph"],
    });
    continue;
  }
  const contents = JSON.stringify(w.template, null, 2) + "\n";
  await writeFile(resolve(directory, w.id + ".json"), contents);
  entries.push({
    id: w.id,
    name: w.name,
    kind: w.output.kind,
    file: w.id + ".json",
    availability: workflowAvailability(w),
    source: w.source?.file,
    sha256: createHash("sha256").update(contents).digest("hex"),
    requiredInputs: w.requiredInputs,
    mapping: w.mapping,
    parameters: w.parameters,
    output: w.output,
  });
}
await writeFile(
  resolve(root, "deploy/autodl/recipe-manifest.json"),
  JSON.stringify(
    {
      scope:
        "Default-output API adaptations without unresolved UI conversions. Missing cloud dependencies are separately recorded; no execution is implied. Complete original workflows ship in public/mirror/workflows.",
      entries,
      unavailable,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Catalog: ${catalog.length}; default-output graphs exported: ${entries.length}; pending adaptation: ${unavailable.length}`,
);
const lines = [
  "# 镜像目录补全记录",
  "",
  "更新：2026-09-24。本轮遵照用户要求不执行生成或自动化测试，只做目录核对、代码适配与编译。",
  "",
  "镜像内 96 份 VRGDG 工作流，加 11 份插件示例，共 107 份源文件；8 份训练文件按用户决定排除，1 份原文件为空或无效。其余 99 项（含无效文件的问题条目）均保留在画布选择器中。另有 43 个画布专用配方。",
  "",
  "模型文件清单共 59 项，另记录 91 个源工作流引用但当前未安装的模型名称。已有文件、缺失依赖、未转换子图与未试跑状态分别展示，不代表全部可以执行。",
  "",
  "使用方式：选择节点 → 打开底部工作流选择器 → 工作流 / 模型与 LoRA；搜索或勾选全部节点类型。高级参数按原节点分组，可搜索模型名和字段。多个结果可在输出结果菜单切换。",
  "",
  `默认输出可导出 API 图 ${entries.length} 项，尚需适配 ${unavailable.length} 项。前者仍可能缺少模型或节点；此数字不代表试跑通过数。`,
  "",
  "## 默认输出仍需适配的条目",
  "",
];
for (const w of unavailable) lines.push(`- ${w.name}：${w.issues.join("；")}`);
lines.push(
  "",
  "完整逐文件来源、哈希、模型和依赖见 deploy/autodl/mirror-inventory.json；原始 JSON 随网页与桌面资源一起打包。源文件经过凭据字段清理，SHA-256 记录审计原件。",
  "",
);
await writeFile(resolve(root, "MIRROR-COVERAGE.md"), lines.join("\n"));
