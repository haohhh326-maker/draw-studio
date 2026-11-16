import { useId, useState } from "react";
import { isWorkflowCredentialFieldName } from "./credentials";
import type {
  ImportEnvironmentDiagnostic,
  ImportEnvironmentDiagnosticCategory,
  ImportEnvironmentCapabilities,
  ImportEnvironmentReport as ImportEnvironmentReportData,
} from "./import-environment-diagnostics";

const categoryOrder: ImportEnvironmentDiagnosticCategory[] = [
  "unsupported", "missing-node", "model-unavailable", "asset-unavailable", "option-mismatch", "schema-mismatch", "other",
];

const liveCategoryLabels: Record<ImportEnvironmentDiagnosticCategory, string> = {
  unsupported: "当前应用不支持",
  "missing-node": "云端未加载节点",
  "model-unavailable": "云端未匹配模型",
  "asset-unavailable": "云端未匹配素材",
  "option-mismatch": "参数选项不一致",
  "schema-mismatch": "节点定义不一致",
  other: "其他待检查项",
};

const liveCategoryDescriptions: Record<ImportEnvironmentDiagnosticCategory, string> = {
  unsupported: "这些项需要补齐应用的读取或执行兼容能力，并不代表原工作流填写错误。",
  "missing-node": "云端未提供以下节点类，可能尚未安装、未加载或版本不同。",
  "model-unavailable": "以下文件名未出现在当前云端节点的模型列表中。",
  "asset-unavailable": "以下素材未出现在当前云端节点的文件列表中。",
  "option-mismatch": "工作流保存的选项与当前云端节点提供的选项不一致。",
  "schema-mismatch": "工作流的字段或参数与当前云端节点定义不一致，请检查节点版本和参数。",
  other: "请按每项说明处理，再重新读取并检查。",
};

type Capabilities = ImportEnvironmentCapabilities;
const capabilityDescriptions: Record<Capabilities, string> = {
  platform: "已读取 RunningHub 平台通用节点定义，实际任务环境由平台校验。",
  live: "已读取当前云端节点列表；实际运行和生成尚未验证。",
  cached: "当前连接不可用，使用该云端以前的节点列表。缺项仅供参考，需要重新连接检查。",
  unavailable: "未获得云端节点列表，环境是否齐全尚未确认。",
};

function categoryLabels(capabilities: Capabilities): Record<ImportEnvironmentDiagnosticCategory, string> {
  if (capabilities === "live") return liveCategoryLabels;
  if (capabilities === "platform") return { ...liveCategoryLabels, "missing-node": "平台节点待确认", "model-unavailable": "平台模型待确认" };
  return { ...liveCategoryLabels,
    "missing-node": capabilities === "cached" ? "以前列表未提供节点" : "节点待确认",
    "model-unavailable": capabilities === "cached" ? "以前列表未匹配模型" : "模型待确认",
    "asset-unavailable": capabilities === "cached" ? "以前列表未匹配素材" : "素材待确认",
    "option-mismatch": capabilities === "cached" ? "以前列表选项不一致" : "参数选项待确认",
    "schema-mismatch": capabilities === "cached" ? "以前节点定义不一致" : "节点定义待确认",
  };
}

function categoryDescription(category: ImportEnvironmentDiagnosticCategory, capabilities: Capabilities): string {
  if (capabilities === "platform" && ["missing-node", "model-unavailable"].includes(category)) return "平台通用列表未包含以下项目，不代表工作流缺失节点或模型；原值已完整保留，实际可用性以 RunningHub 执行校验为准。";
  if (capabilities === "platform") return liveCategoryDescriptions[category];
  if (capabilities === "live" || category === "unsupported" || category === "other") return liveCategoryDescriptions[category];
  if (capabilities === "unavailable") return "以下为工作流读取提示。尚未获得云端节点列表，请重新连接后确认当前环境。";
  return {
    "missing-node": "以下节点未出现在该云端以前返回的定义中，重新连接后再确认是否缺失。",
    "model-unavailable": "以下文件名未匹配以前节点定义中的模型列表，重新连接后再确认。",
    "asset-unavailable": "以下素材未匹配以前节点定义中的文件列表，重新连接后再确认。",
    "option-mismatch": "工作流保存的选项与以前返回的节点选项不一致，当前选项需要重新检查。",
    "schema-mismatch": "工作流与以前返回的节点定义不一致，当前节点版本和参数需要重新检查。",
  }[category];
}

function capabilityFootnote(capabilities: Capabilities) {
  if (capabilities === "platform") return "RunningHub 通用列表用于读取结构，不用于判断实际任务的模型库存，也不会据此自动安装插件或替换模型。";
  if (capabilities === "live") return "检查依据为当前可读取的云端节点定义和文件选项。处理完成后可重新读取并检查；实际运行和生成仍需验证。";
  if (capabilities === "cached") return "检查依据为该云端以前返回的节点定义和文件选项。请重新连接后再检查当前环境。";
  return "未获得云端节点列表，以上为工作流读取阶段的提示。请连接对应 ComfyUI 后重新检查。";
}

const MAX_VISIBLE_OPTIONS = 5;
const printableValue = (value: string | number | boolean | null) => value === "" ? "（空值）" : String(value);
const hideFieldValue = (issue: ImportEnvironmentDiagnostic) => issue.valueStatus === "redacted"
  || !!issue.field && (isWorkflowCredentialFieldName(issue.field)
    || /(?:^|[_.:\s-])(?:prompt|text|positive|negative|instruction|password|passwd|secret|credential)(?:$|[_.:\s-])/i.test(issue.field));

function issueValue(issue: ImportEnvironmentDiagnostic): string | undefined {
  if (hideFieldValue(issue)) return "已隐藏提示词或敏感值";
  return issue.valueStatus !== "available" || issue.actualValue === undefined ? undefined : printableValue(issue.actualValue);
}

/** A local, readable checklist; no workflow JSON or raw diagnostic payload is copied. */
export function formatImportEnvironmentChecklist(report: ImportEnvironmentReportData): string {
  const capabilities = report.capabilities ?? "unavailable";
  const labels = categoryLabels(capabilities);
  const lines = ["工作流待处理清单", capabilityDescriptions[capabilities], "示例素材已跳过读取与校验；只检查输入结构、节点、模型和参数。", report.summary];
  for (const category of categoryOrder) {
    const issues = report.issues.filter(issue => issue.category === category);
    if (!issues.length) continue;
    lines.push("", `${labels[category]}（${issues.length} 项）`);
    for (const issue of issues) {
      lines.push(`- ${issue.title}`);
      if (issue.nodeId || issue.classType || issue.nodeTitle) {
        lines.push(`  节点：${[issue.nodeTitle, issue.nodeId ? `#${issue.nodeId}` : "", issue.classType].filter(Boolean).join(" · ")}`);
      }
      if (issue.field) lines.push(`  字段：${issue.field}`);
      const value = issueValue(issue);
      if (value !== undefined) lines.push(`  工作流原值：${value}`);
      lines.push(`  说明：${issue.message}`, `  处理：${issue.action}`);
    }
  }
  lines.push("", "计数按诊断所在节点或字段统计。", capabilityFootnote(capabilities));
  return lines.join("\n");
}

function EnvironmentIssue({ issue, capabilities }: { issue: ImportEnvironmentDiagnostic; capabilities: Capabilities }) {
  const value = issueValue(issue);
  const showOptions = !hideFieldValue(issue) && (issue.allowedValues !== undefined || issue.allowedValueCount !== undefined);
  const options = issue.allowedValues?.slice(0, MAX_VISIBLE_OPTIONS) ?? [];
  const optionCount = Math.max(issue.allowedValueCount ?? 0, issue.allowedValues?.length ?? 0);
  const remainingOptions = Math.max(0, optionCount - options.length);
  return <li className="workflow-environment-issue">
    <div className="workflow-environment-issue-heading">
      <strong>{issue.title}</strong>
      <span className={"workflow-environment-severity " + issue.severity}>{issue.severity === "error" ? capabilities === "live" || issue.category === "unsupported" ? "需处理" : "待确认" : "提示"}</span>
    </div>
    {(issue.nodeTitle || issue.nodeId || issue.classType) && <p className="workflow-environment-location">
      {issue.nodeTitle && <span>{issue.nodeTitle}</span>}
      {issue.nodeId && <code>节点 #{issue.nodeId}</code>}
      {issue.classType && <code>{issue.classType}</code>}
    </p>}
    {issue.field && <p className="workflow-environment-field">字段：<code>{issue.field}</code></p>}
    {value !== undefined && <div className="workflow-environment-value"><span>{issue.category === "model-unavailable" || issue.category === "asset-unavailable" ? "工作流引用文件" : "工作流原值"}</span><code>{value}</code></div>}
    <p className="workflow-environment-message">{issue.message}</p>
    <p className="workflow-environment-action"><strong>处理方法：</strong>{issue.action}</p>
    {showOptions && <details className="workflow-environment-options">
      <summary>{capabilities === "platform" ? "平台通用列表（非任务库存）" : capabilities === "live" ? "云端可选值" : capabilities === "cached" ? "以前返回的可选值" : "可选值参考（未验证）"}（{optionCount} 项）{remainingOptions > 0 ? ` · 展开查看前 ${options.length} 项` : ""}</summary>
      {options.length ? <ul>{options.map((option, index) => <li key={index}><code>{printableValue(option)}</code></li>)}</ul> : <p>{capabilities === "live" ? "当前云端没有返回可选值。" : "没有可供参考的选项，请重新连接检查。"}</p>}
      {remainingOptions > 0 && <p>另有 {remainingOptions} 项。请在对应 ComfyUI 节点中查看完整列表。</p>}
    </details>}
    <details className="workflow-environment-technical">
      <summary>诊断详情</summary>
      <dl>
        <div><dt>诊断代码</dt><dd><code>{issue.code}</code></dd></div>
        {issue.expectedType && <div><dt>{capabilities === "live" ? "云端要求类型" : "参考类型"}</dt><dd><code>{issue.expectedType}</code></dd></div>}
        {(issue.minimum !== undefined || issue.maximum !== undefined) && <div><dt>{capabilities === "live" ? "云端参数范围" : "参考参数范围"}</dt><dd>{issue.minimum ?? "不限"} ～ {issue.maximum ?? "不限"}</dd></div>}
      </dl>
    </details>
  </li>;
}

export function ImportEnvironmentReport({ report }: { report: ImportEnvironmentReportData }) {
  const detailId = useId();
  const [selection, setSelection] = useState<{ reportKey: string; category: ImportEnvironmentDiagnosticCategory }>();
  const capabilities = report.capabilities ?? "unavailable";
  const labels = categoryLabels(capabilities);
  const unsupported = report.counts.byCategory.unsupported;
  const reportKey = JSON.stringify([capabilities, report.issues.map(issue => [issue.id, issue.actualValue])]);
  const selected = selection?.reportKey === reportKey ? report.groups.find(group => group.category === selection.category) : undefined;
  return <section className="workflow-environment-report" aria-label="工作流云端环境检查">
    <p className="workflow-environment-scope">示例素材已跳过读取与校验；只检查输入结构、节点、模型和参数。</p>
    {unsupported > 0 && <p className="workflow-environment-unsupported"><strong>当前应用有 {unsupported} 处兼容能力尚未接齐。</strong> 这些项需要软件侧修复，安装插件或补充模型不能单独解决。可先在原 ComfyUI 中运行。</p>}
    {!!report.counts.total && <div className="workflow-environment-counts" role="group" aria-label="缺项分类">
      {categoryOrder.filter(category => report.counts.byCategory[category] > 0).map(category => <button key={category} type="button"
        className={category === "unsupported" ? "unsupported" : undefined}
        aria-expanded={selected?.category === category} aria-controls={detailId}
        onClick={() => setSelection(selected?.category === category ? undefined : { reportKey, category })}>
        <span className="workflow-environment-count-label">{labels[category]}</span>
        <span className="workflow-environment-count-value">{report.counts.byCategory[category]}<span>{category === "unsupported" || category === "other" ? "项" : "处"}</span></span>
      </button>)}
    </div>}
    {!report.counts.total && <p className="workflow-environment-scope">{capabilityDescriptions[capabilities]}{report.summary}</p>}
    <div id={detailId} className="workflow-environment-groups" hidden={!selected}>
      {selected && <section className="workflow-environment-group" key={selected.category} aria-label={labels[selected.category]}>
        <h4>{labels[selected.category]}<span>{selected.issues.length} 项</span></h4>
        <p className="workflow-environment-group-description">{categoryDescription(selected.category, capabilities)}</p>
        <ul className="workflow-environment-issues">{selected.issues.map(issue => <EnvironmentIssue key={issue.id} issue={issue} capabilities={capabilities} />)}</ul>
      </section>}
    </div>
  </section>;
}
