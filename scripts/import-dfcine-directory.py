"""Read only DFCine's plain configuration/model manifests into the local canvas.

Never decrypt execution files, touch the source app, connect to a server, or infer
an executable workflow from names. Membership comes from the user-approved list.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
manifest = json.loads(subprocess.check_output([
    'node', '--experimental-strip-types', '--input-type=module', '-e',
    "import {dfcineDirectory} from './src/workflow/dfcine-directory.ts'; console.log(JSON.stringify(dfcineDirectory))",
], cwd=ROOT, encoding='utf-8'))

def read(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))

def zh(v, fallback=''):
    return v.get('zh-CN', v.get('en-US', fallback)) if isinstance(v, dict) else v or fallback

def norm(s):
    return ''.join(s.split()).lower()

configs = {}
for file in source.glob('*/workflow.config.json'):
    config = read(file)
    if config.get('runnerType') == 'comfyui':
        key = norm(zh(config.get('nameLabel'), config.get('name')))
        if key in configs:
            raise ValueError('Ambiguous source: ' + key)
        configs[key] = (file, config)

# Explicit display-name differences; no fuzzy or model-name-based matching.
aliases = {
    'Krea2 文生图': 'Krea2文生图 Turbo',
    'Zimage 日本风格': 'Ziamge日本风格',
}
types = {'integer': 'number', 'float': 'number', 'seed': 'number',
         'enum': 'select', 'string': 'text', 'boolean': 'boolean'}
result = {}
rows = []
files = set()
model_names = set()
for canvas in manifest:
    for series in canvas['series']:
        for entry in series['workflows']:
            ident = 'dfcine-v2-' + '-'.join([canvas['id'], series['id'], entry['key']])
            match = configs.get(norm(aliases.get(entry['name'], entry['name'])))
            if not match:
                rows.append((canvas['name'], series['name'], entry['name'], '未找到配置', '—'))
                continue
            file, config = match
            assert config['nodeKind'] == canvas['outputKind'], (entry['name'], config['nodeKind'])
            files.add(str(file))
            execution_name = config.get('execution', {}).get('file', '')
            execution = file.parent / execution_name
            # Only metadata/hash: the encrypted payload is not copied or decoded.
            status = 'encrypted' if execution_name.endswith('.dfenc') and execution.is_file() else 'missing'
            parameters = []
            bindings = {}
            for item in config.get('parameters', []):
                value = item.get('defaultValue', '')
                assert isinstance(value, (str, int, float, bool)), (entry['name'], item['id'])
                p = {'key': item['id'], 'label': zh(item.get('label'), item['id']),
                     'type': types[item['type']], 'default': value,
                     'advanced': item.get('ui', {}).get('placement') == 'advanced'}
                for key in ['min', 'max', 'step', 'required']:
                    if key in item: p[key] = item[key]
                # Four source configs ship seed defaults above their UI maximum.
                # Keep the original seed, but allow that safe integer in our form.
                if item['type'] == 'seed' and isinstance(value, int) and 0 <= value <= 9007199254740991:
                    p['max'] = max(p.get('max', value), value)
                if item['type'] == 'string': p['multiline'] = bool(item.get('ui', {}).get('multiline', False))
                if item['type'] == 'enum':
                    options = item.get('options', [])
                    p['options'] = [str(o['value']) for o in options]
                    p['optionLabels'] = {str(o['value']): zh(o.get('label'), str(o['value'])) for o in options}
                    p['optionValues'] = {str(o['value']): o['value'] for o in options}
                parameters.append(p)
                if item.get('binding'): bindings[item['id']] = item['binding']
            requirements_name = config.get('execution', {}).get('modelRequirementsFile', 'model.requirements.json')
            requirements_file = file.parent / requirements_name
            requirements = read(requirements_file) if requirements_file.is_file() else {}
            models = [{k: m[k] for k in ['name', 'relativePath', 'required'] if k in m}
                      for m in requirements.get('items', [])]
            model_names.update(m['name'] for m in models)
            original = {
                'id': config['id'], 'version': config.get('version', ''),
                'folder': file.parent.name, 'configFile': file.relative_to(source).as_posix(),
                'configSha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                'executionFile': execution_name, 'executionStatus': status,
                'executionSha256': hashlib.sha256(execution.read_bytes()).hexdigest() if execution.is_file() else '',
                'inputs': [{k: i[k] for k in ['id', 'name', 'dataType', 'required', 'description', 'binding'] if k in i}
                           for i in config.get('inputs', [])],
                'models': models,
                'docsUrl': config.get('docs', {}).get('localizedUrls', {}).get('zh-CN', ''),
                'promptPlaceholder': zh(config.get('promptPlaceholder')),
                'promptBinding': config.get('prompt', {}).get('binding'),
                'parameterBindings': bindings,
            }
            result[ident] = {'parameters': parameters, 'original': original}
            rows.append((canvas['name'], series['name'], entry['name'], '配置已核对 / 执行文件加密' if status == 'encrypted' else '执行文件缺失', file.parent.name))

assert len(rows) == 65
assert len({r[1] for r in rows}) == 16
target = ROOT / 'src/workflow/original-configs.json'
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
report = [
    '# DFCine 目录重建与来源核对（2026-09-28）', '',
    '以用户确认清单为唯一目录：音乐 2 系列 / 3 入口，图像 5 系列 / 22 入口，视频 9 系列 / 40 入口。', '',
    '旧 142 项混合目录已从应用运行入口移除；不再导入插件示例、旧版批处理、训练或自行扩展配方。', '',
    '## 找到的真实来源', '',
    '`' + str(source) + '`', '',
    f'65 个目录入口中，{len(result)} 个匹配到配置，来自 {len(files)} 个独立配置文件。Klein 高清放大保留两个分类入口并共享来源。', '',
    '名称差异明确记录：目录「Krea2 文生图」对应源配置「Krea2文生图 Turbo」；目录「Zimage 日本风格」对应源配置原拼写「Ziamge日本风格」。其余按去空白、忽略大小写后的名称精确匹配，不使用模糊匹配。', '',
    f'导入真实输入要求、参数默认值/范围/选项、原绑定元数据与 {len(model_names)} 个不同的模型文件名。模型需求不等于云端已安装。', '',
    '原始执行文件为 execution.comfyui.dfenc。现已按本机原客户端的容器读取方式载入 64 个入口的 API 执行图，并完成素材、参数和输出绑定；原始文件保持不变。FlashVSR 未在此本地工作流包中找到。执行图导入脚本为 scripts/import-dfcine-execution.mjs。', '',
    '生成按钮已为 64 项恢复。当前云端依赖静态核对：37 项通过，27 项存在节点或模型选项缺失；缺失详情和测试交付见 [DFCINE-CLOUD-CHECK.md](DFCINE-CLOUD-CHECK.md)。没有进行云端生成试跑。', '',
    '查找时仅对镜像进行文件只读扫描，没有修改任何远端文件、模型、节点或服务，没有提交生成任务。客户端源目录亦只读。', '',
    '原项目的节点、连线、素材和任务执行快照保持不变。旧目录中的节点保留原配置值，需手动选择新目录条目，不按相似名称强制迁移。', '',
    '旧公开示例文件归档到 `archive/retired-catalog-20260927/mirror`，不随新版本网页发布。', '',
    '## FlashVSR 查找结果', '',
    '官方说明：https://www.digitfold.com/5464.html 。页面下载区要求登录，本机版本 0.3.2（build 2026082701）中未找到此工作流；未取得原始配置或执行 JSON。当前服务也没有注册该本地插件节点，不能以外部收费 API 节点替代。', '',
    '页面列出 models/FlashVSR-v1.1 下的 4 个模型：diffusion_pytorch_model_streaming_dmd.safetensors、Wan2.1_VAE.pth、LQ_proj_in.ckpt、TCDecoder.ckpt。界面单独标注为官方说明来源，不计入上述从配置导入的 70 个模型名，也不推断参数或执行图。', '',
    '## 逐项对应', '', '| 画布 | 系列 | 工作流入口 | 状态 | 原始文件夹 |', '|---|---|---|---|---|',
]
report += ['| ' + ' | '.join(r) + ' |' for r in rows]
(ROOT / 'DFCINE-DIRECTORY-AUDIT.md').write_text('\n'.join(report) + '\n', encoding='utf-8')
print(json.dumps({'entries': len(rows), 'matchedEntries': len(result), 'uniqueConfigs': len(files),
                  'modelNames': len(model_names), 'missing': [r[2] for r in rows if r[3] == '未找到配置']}, ensure_ascii=False))
