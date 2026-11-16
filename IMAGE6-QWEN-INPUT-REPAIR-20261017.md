# 图像 6：Qwen 图像编辑参考图输入修复

2026-10-17，已完成本地代码修复与真实云端执行验证。

## 原因

原失败任务 `e6af2be0-c6fe-4afd-ac6d-c62c00504af8` 在 `459:474 / TextEncodeQwenImage21` 报错：

```text
TextEncodeQwenImage21.execute() got an unexpected keyword argument 'images.image_0'
```

实际安装库 `Qwen-Image21-Edit/workflow.config.json` 已设置 `dynamicInput.routes.image.targetInputStartIndex: 1`，云端该节点的 AUTOGROW 定义也列出 `image_1` 至 `image_16`。画布的动态参考图组装逻辑忽略了起始索引，错误地产生 `images.image_0`。这不是本次界面文案调整导致的参数缺失。

## 修复

- `src/workflow-adapter/adapter.ts` 按 `targetInputStartIndex + index` 生成动态参考图输入名。
- `src/types/index.ts` 声明可选起始索引。
- `src/workflow/library-converter.ts` 验证非负安全整数及输入编号范围。
- `tests/adapter.test.ts` 覆盖从 1 开始、其他明确索引、缺省/显式 0、多图顺序和模板不变性。
- `tests/workflow-library-reader.test.ts` 覆盖真实读取链、旧配置兼容和无效索引。

未修改用户工作流配置、模型、云端代码或连线。没有新增生成前的云端节点扫描；未配置起始索引的 H3 工作流继续从 0 开始。

## 验证

- 全量 Vitest：81 个文件通过，1197 项通过，3 项跳过。
- `npm run build` 通过。
- 使用实际安装库读取器和修复后的 `buildWorkflow`，重建原失败任务的同一提示词、种子和已有参考图片上传路径。
- 修复后提交字段为 `images.image_1`，已与云端实际节点定义核对。
- 真实云端验证任务 `b13ff532-64d9-4626-86b1-69a3908bc342` 返回 `success / completed: true`，输出节点 `461` 正常生成图像。
- 诊断输出独立保存至 `draw-studio-diagnostics/qwen-numbering-1792171913545/result_00001.png`，未替换画布现有结果或加入资产库。
- 本地结果：[实测图像](.cache/qwen-image6-verification-20261017.png)，摘要记录在 `.cache/qwen-input-repair-20261017.json`。

本地页面更新后，可在图像 6 再次点击生成。原失败任务保留其真实历史状态。
