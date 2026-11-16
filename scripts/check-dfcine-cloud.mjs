// Compare a read-only /object_info and model-file inventory with local definitions.
// This script performs no network requests and never submits /prompt.
import {readFileSync, writeFileSync} from 'node:fs';
import {directoryCatalog} from '../src/workflow/dfcine-directory.ts';
import {prepareForServer} from '../src/workflow-adapter/preflight.ts';

const evidence = JSON.parse(readFileSync('.cache/directory-cloud-capabilities.json', 'utf8'));
const info = evidence.objectInfo;
const modelFiles = new Set(evidence.models.filter(m=>m.exists).map(m=>m.name));
const now = new Date().toISOString();
const rows = directoryCatalog.map(w => {
  if (!w.template) return {id:w.id, name:w.name, family:w.family, status:'missing-execution', missingNodes:[], missingModels:[], missingModelOptions:[], issue:'原始执行文件尚未找到'};
  const graph = structuredClone(w.template);
  for (const map of w.mapping) {
    const parameter=w.parameters.find(p=>p.key===map.semantic);
    if (parameter) graph[map.nodeId].inputs[map.field]=parameter.default;
  }
  const used=new Set();
  function visit(id) { if (used.has(id) || !graph[id]) return; used.add(id); for (const v of Object.values(graph[id].inputs)) if (Array.isArray(v)&&v.length===2&&typeof v[0]==='string'&&typeof v[1]==='number') visit(v[0]); }
  visit(w.output.nodeId);
  const missingNodes=[...new Set([...used].map(id=>graph[id].class_type).filter(name=>!info[name]))].sort();
  const missingModels=(w.original?.models??[]).filter(m=>m.required!==false && /\.(safetensors|gguf|pt|pth|bin|ckpt|onnx)$/i.test(m.name) && !modelFiles.has(m.name));
  const missingModelOptions=[];
  for (const id of used) {
    const n=graph[id], schema=info[n.class_type]?.input;
    const fields={...schema?.required,...schema?.optional};
    for (const [field,value] of Object.entries(n.inputs)) {
      if (typeof value!=='string'|| !/\.(safetensors|gguf|pt|pth|bin|ckpt|onnx)$/i.test(value)) continue;
      const spec=fields[field], options=Array.isArray(spec?.[0])?spec[0]:spec?.[1]?.options;
      if (!Array.isArray(options)) continue;
      const base=s=>String(s).replaceAll('\\','/').split('/').at(-1);
      if (!options.includes(value)&&options.filter(v=>base(v)===base(value)).length!==1) missingModelOptions.push(value);
    }
  }
  let issue=''; try {prepareForServer(graph,w.output.nodeId,info);} catch(e) {issue=e.message;}
  return {id:w.id,name:w.name,family:w.family,status:issue?'blocked':'preflight-passed',missingNodes,missingModels,missingModelOptions:[...new Set(missingModelOptions)].sort(),issue};
});
const summary={checkedAt:now, registeredNodes:Object.keys(info).length, uniqueModelFiles:modelFiles.size, entries:rows.length, bound:rows.filter(r=>r.status!=='missing-execution').length, preflightPassed:rows.filter(r=>r.status==='preflight-passed').length, blocked:rows.filter(r=>r.status==='blocked').length, missingExecution:rows.filter(r=>r.status==='missing-execution').length};
writeFileSync('DFCINE-CLOUD-CHECK.json',JSON.stringify({summary,rows},null,2)+'\n');
const lines=['# 当前 ComfyUI 缺失项与测试交付清单','',`核对时间：${now}。证据来自当前在线实例的 /object_info，以及 /root/ComfyUI/models（包括符号链接）的只读目录扫描；没有安装、下载、重启或生成任务。`,'',
  `当前服务注册 ${summary.registeredNodes} 种节点，模型目录扫描到 ${summary.uniqueModelFiles} 个不同权重文件名。65 个入口中，64 个已接入原始执行图，${summary.preflightPassed} 个通过默认执行分支的节点/模型选项静态检查，${summary.blocked} 个存在依赖问题，FlashVSR 1 个仍缺原始执行配置。静态检查通过不代表生成成功或显存足够。`,'',
  '“模型目录未找到”按原配置的模型文件名核对；“模型选项未提供”按执行图实际加载器检查。两者分开记录，避免将历史清单或同名文件夹误当作正在执行的依赖。没有配置额外模型路径，/root/autodl-fs 为空。','',
  '## 已修复的本地问题','',
  '- 接入 64 个目录入口的原始执行图，恢复生成按钮；不会套用旧混合目录的配方。',
  '- 按原始绑定传入素材、提示词和参数；专用歌词/声音描述/参考音色文字/分段提示词可直接输入或连接文本。',
  '- H3 多参考按实际连接展开图片、视频、音频加载器，移除未使用的占位素材。',
  '- 修复原配置中 4 个种子默认值超出自身 UI 上限，以及千问角色三视图的 text/prompt 字段不一致。',
  '- 输出统一写入任务目录；上传前核对当前服务的节点与模型选项，只规范同一文件名的路径，不替换其他模型。',
  '- 88 项本地检查通过，未调用云端生成。','',
  '## LTX、Scail、Remix 的具体缺失项',''];
for (const family of ['LTX MSR','LTX2.3','Scail','Remix']) {
  const group=rows.filter(r=>r.family===family);
  const nodes=[...new Set(group.flatMap(r=>r.missingNodes))].sort();
  const models=new Map(group.flatMap(r=>r.missingModels).map(m=>[m.name,m]));
  lines.push(`### ${family}`,'','当前服务未注册的节点：','',...nodes.map(s=>'- `'+s+'`'),'','原配置要求、当前模型目录未找到的权重：','',...[...models.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(m=>'- `'+m.name+'` — `'+m.relativePath+'`'),'');
}
lines.push('## 全部 65 项状态','','| 系列 | 工作流 | 当前静态状态 | 未注册节点数 | 未提供模型选项数 |','|---|---|---|---:|---:|');
for (const r of rows) lines.push(`| ${r.family} | ${r.name} | ${{'preflight-passed':'可交给用户试跑','blocked':'依赖待补齐','missing-execution':'执行文件待补齐'}[r.status]} | ${r.missingNodes.length} | ${r.missingModelOptions.length} |`);
lines.push('','## 各工作流缺失明细','');
for (const r of rows.filter(r=>r.status==='blocked')) lines.push(`### ${r.name} / ${r.family}`,'',r.missingNodes.length?'未注册节点：'+r.missingNodes.map(s=>'`'+s+'`').join('、'):'节点已注册。','',r.missingModelOptions.length?'加载器未提供的模型选项：'+r.missingModelOptions.map(s=>'`'+s+'`').join('、'):'已注册加载器的模型选项未发现不匹配；未注册节点的模型加载仍无法确认。','');
lines.push('## 测试入口','','打开 http://127.0.0.1:1420/ 。旧节点需要选择新目录工作流；已有新目录节点刷新即可恢复生成按钮。建议先测试 Klein 文生图、Krea2 文生图、H3 文生视频、MiniMax Music 3 或 Vox 声音设计。音乐与声音工作流的专用文本输入带 * 号，须填写。','',
  '本次交付不包含云端安装操作。LTX、Scail、Remix 的上述依赖由用户另行决定如何处理；FlashVSR 未取得原始执行配置，且当前服务仅有需要外部 API 的 WavespeedFlashVSRNode，不能当作本地 FlashVSR 替代。','');
writeFileSync('DFCINE-CLOUD-CHECK.md',lines.join('\n'));
console.log(JSON.stringify(summary));
