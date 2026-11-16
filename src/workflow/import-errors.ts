import { MissingWorkflowNodeDefinitionError } from "./import-editor";

type SchemaContext = { connectedAddress: boolean; info?: Record<string, unknown>; warnings: string[] };

/** A failed schema request does not prove that the remote plugin is missing. */
export function describeWorkflowImportError(reason: unknown, context: SchemaContext): string {
  if (reason instanceof SyntaxError) return "文件不是有效 JSON，请重新导出工作流。";
  if (!(reason instanceof MissingWorkflowNodeDefinitionError)) return reason instanceof Error ? reason.message : String(reason);
  const label = `节点 ${reason.nodeId}（${reason.nodeType}）`;
  const savedData = "普通 JSON 没有保存足够的参数名称与顺序，暂时无法准确转换。";
  if (context.info) {
    const source = context.warnings.length ? "此前缓存的 ComfyUI 节点定义" : "当前 ComfyUI 返回的节点定义";
    if (Object.hasOwn(context.info, reason.nodeType)) return `${label}的参数定义不完整。${savedData}请检查对应插件是否正确加载，再点击“重试添加”。`;
    return `${source}中没有 ${reason.nodeType}。${savedData}请在运行此工作流的 ComfyUI 中安装或加载对应插件，再点击“重试添加”；不需要补交另一份工作流文件。`;
  }
  if (!context.connectedAddress) return `${label}需要对应插件的参数定义。${savedData}请先配置运行此工作流的 ComfyUI 服务地址，再点击“重试添加”。`;
  return `${label}需要对应插件的参数定义，但本次未能读取 ComfyUI 的节点定义。${savedData}请恢复连接后点击“重试添加”；当前还不能判断云端是否缺少该插件。`;
}
