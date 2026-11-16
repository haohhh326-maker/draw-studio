"""Import audited ComfyUI files into the canvas. Never submit a prompt.

UI conversion is conservative: unresolved widgets/links are recorded per node,
not silently replaced with guessed API values. Source files remain downloadable.
"""
import argparse
import base64
import collections
import copy
import gzip
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--audit', required=True)
args = parser.parse_args()
audit = Path(args.audit)
root = Path(__file__).resolve().parents[1]
schema = json.loads((audit / 'object-info-full.json').read_text(encoding='utf-8'))
sources = {p.relative_to(audit / 'mirror-workflows').as_posix(): p.read_bytes()
           for p in sorted((audit / 'mirror-workflows').rglob('*.json'))}
examples = audit / '61-workflow-examples.txt'
if examples.exists():
    for name, value in json.loads(gzip.decompress(base64.b64decode(examples.read_text()))).items():
        sources['插件示例/' + name] = json.dumps(value, ensure_ascii=False).encode()
models = json.loads((audit / '58-model-inventory.txt').read_text(encoding='utf-8'))['models']
for m in models:
    m['workflows'] = []
available = {m['name'] for m in models if m['available']}
extension = re.compile(r'\.(safetensors|gguf|ckpt|pth|pt|bin|onnx|model)$', re.I)
credential = re.compile(r'(^|_)(api_?key|password|token|secret|authorization)($|_)', re.I)


def clean(value):
    if isinstance(value, dict):
        return {k: ('' if credential.search(k) and isinstance(v, str) else clean(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        return re.sub(r'\b(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{25,})\b', '', value)
    return value


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


def input_specs(typ):
    info = schema.get(typ, {})
    result = {}
    for section in ('required', 'optional'):
        specs = info.get('input', {}).get(section, {})
        order = info.get('input_order', {}).get(section, list(specs))
        for key in order:
            if key in specs:
                result[key] = specs[key]
    return result


def is_widget(spec):
    return isinstance(spec[0], list) or spec[0] in ('INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO')


def widget_values(node, issues):
    specs = input_specs(node['type'])
    values = node.get('widgets_values', [])
    if isinstance(values, dict):
        # VHS format widgets are generated dynamically and are not in INPUT_TYPES.
        return {k: v for k, v in values.items() if k in specs or (node['type'] == 'VHS_VideoCombine' and k in ('pix_fmt', 'crf', 'save_metadata', 'trim_to_audio'))}
    if not specs and values:
        issues.append('缺少节点定义，无法转换控件：' + node['type'])
        return {}
    result, cursor = {}, 0
    for key, spec in specs.items():
        options = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        if not is_widget(spec) or options.get('forceInput'):
            continue
        if cursor < len(values):
            result[key] = values[cursor]
            cursor += 1
            if (options.get('control_after_generate') or key in ('seed', 'noise_seed')) and cursor < len(values) and values[cursor] in ('fixed', 'increment', 'decrement', 'randomize'):
                cursor += 1
        elif 'default' in options:
            result[key] = options['default']
    # Upload buttons, previews and other frontend widgets are not API inputs.
    # Unknown extra serialized values can mean a changed custom-node contract.
    extras = values[cursor:]
    if node['type'] not in ('VRGDG_ShowText', 'ShowText|pysssss', 'SaveVideo', 'VHS_VideoCombine') and extras and any(not isinstance(v, (dict, list)) and v not in (None, '', 'image', 'video', 'audio', 'choose file to upload', 'fixed', 'randomize') for v in extras):
        issues.append('控件版本需要核对：' + node['type'])
    return result


def convert_ui(workflow):
    definitions = {s['id']: s for s in workflow.get('definitions', {}).get('subgraphs', [])}
    flat, contexts, issues, titles = {}, {}, {}, {}

    def expand(graph, prefix='', parent=None, instance=None):
        context = {'graph': graph, 'prefix': prefix, 'parent': parent, 'instance': instance, 'nodes': {str(n['id']): n for n in graph.get('nodes', [])}}
        links = {}
        for raw in graph.get('links', []):
            if isinstance(raw, dict):
                link = [raw['id'], raw['origin_id'], raw['origin_slot'], raw['target_id'], raw['target_slot'], raw.get('type')]
            else:
                link = raw
            links[str(link[0])] = link
        context['links'] = links
        context['children'] = {}
        context['overrides'] = {}
        if instance:
            proxies = instance.get('properties', {}).get('proxyWidgets', [])
            vals = instance.get('widgets_values', [])
            if isinstance(vals, list):
                for (target, field), value in zip(proxies, vals):
                    context['overrides'][(str(target), field)] = value
        for nid, node in context['nodes'].items():
            full = prefix + nid
            if node['type'] in definitions:
                context['children'][nid] = expand(definitions[node['type']], full + ':', context, node)
            else:
                local = []
                values = widget_values(node, local)
                for (target, field), value in context['overrides'].items():
                    if target == nid:
                        values[field] = value
                flat[full] = {'class_type': node['type'], 'inputs': values, '_meta': {'title': node.get('title', node['type'])}}
                contexts[full] = (context, node)
                issues[full] = local
                titles[full] = node.get('title', node['type'])
        return context

    top = expand(workflow)

    def link_value(context, link_id, stack=()):
        link = context['links'].get(str(link_id))
        if not link:
            raise ValueError('找不到连线 ' + str(link_id))
        return output_value(context, str(link[1]), link[2], stack)

    def output_value(context, nid, slot, stack=()):
        identity = (context['prefix'] + nid, slot)
        if identity in stack:
            raise ValueError('循环或无法展开的前端连接')
        stack = stack + (identity,)
        if nid == str(context['graph'].get('inputNode', {}).get('id', -10)) and context['parent']:
            spec = context['graph']['inputs'][slot]
            name = spec['name']
            port = next((p for p in context['instance'].get('inputs', []) if p['name'] == name), {})
            if port.get('link') is not None:
                return link_value(context['parent'], port['link'], stack)
            if ('-1', name) in context['overrides']:
                return context['overrides'][('-1', name)]
            raise ValueError('子图输入未提供：' + name)
        node = context['nodes'].get(nid)
        if not node:
            raise ValueError('找不到源节点 ' + nid)
        if node.get('mode') == 2:
            raise ValueError('输入依赖已禁用的节点')
        if nid in context['children']:
            child = context['children'][nid]
            candidates = [v for v in child['links'].values() if str(v[3]) == str(child['graph'].get('outputNode', {}).get('id', -20)) and v[4] == slot]
            candidates = list({(str(v[1]), v[2]): v for v in candidates}.values())
            if len(candidates) != 1:
                raise ValueError('子图输出连接不唯一')
            return link_value(child, candidates[0][0], stack)
        typ = node['type']
        if typ in ('PrimitiveNode', 'PrimitiveNodeValue'):
            return node.get('widgets_values', [None])[0]
        if typ == 'GetNode':
            name = node.get('widgets_values', [None])[0]
            setters = [n for n in context['nodes'].values() if n['type'] == 'SetNode' and n.get('widgets_values', [None])[0] == name]
            if len(setters) != 1:
                raise ValueError('无法解析命名连接：' + str(name))
            return output_value(context, str(setters[0]['id']), 0, stack)
        if typ in ('Reroute', 'SetNode') or node.get('mode') == 4:
            output_type = (node.get('outputs', [{}])[slot]).get('type')
            candidates = [p for p in node.get('inputs', []) if p.get('link') is not None and (typ in ('Reroute', 'SetNode') or p.get('type') == output_type)]
            if len(candidates) != 1:
                raise ValueError('旁路连接不唯一：' + typ)
            return link_value(context, candidates[0]['link'], stack)
        return [context['prefix'] + nid, slot]

    for full, (context, node) in contexts.items():
        for port in node.get('inputs', []):
            if port.get('link') is None:
                continue
            try:
                flat[full]['inputs'][port['name']] = link_value(context, port['link'])
            except (ValueError, IndexError, KeyError) as exc:
                # An unbound promoted subgraph widget retains the internal widget's
                # serialized value. A bypassed optional socket may remain empty.
                if str(exc).startswith('子图输入未提供：') and port['name'] in flat[full]['inputs']:
                    continue
                optional = schema.get(node['type'], {}).get('input', {}).get('optional', {})
                if str(exc).startswith('旁路连接不唯一：') and port['name'] in optional:
                    link = context['links'].get(str(port['link']))
                    source_node = context['nodes'].get(str(link[1]), {}) if link else {}
                    if source_node.get('mode') == 4 and not any(p.get('link') is not None for p in source_node.get('inputs', [])):
                        continue
                issues[full].append(str(exc))
        if node.get('mode') in (2, 4):
            flat.pop(full, None)
    virtual = {'Note', 'MarkdownNote', 'Reroute', 'SetNode', 'GetNode', 'PrimitiveNode', 'PrimitiveNodeValue', 'Image Comparer (rgthree)', 'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)', 'Power Puter (rgthree)'}
    return {k: v for k, v in flat.items() if v['class_type'] not in virtual}, issues


def output_kind(typ):
    if typ in ('SaveVideo', 'VHS_VideoCombine'):
        return 'video', 'images' if typ == 'SaveVideo' else 'gifs'
    if typ in ('SaveImage', 'PreviewImage', 'SaveImageKJ', 'SaveImageDataSetToFolder', 'SaveImageTextDataSetToFolder'):
        return 'image', 'images'
    if typ.startswith('SaveAudio') or typ == 'PreviewAudio':
        return 'audio', 'audio'
    if typ in ('VRGDG_ShowText', 'ShowText|pysssss', 'PreviewAny'):
        return 'text', 'text'
    if schema.get(typ, {}).get('output_node'):
        return 'file', 'files'
    return None


def family(name):
    low = name.lower()
    for pattern, label in [('seedvr', 'SeedVR2'), ('impact-pack', 'Impact 工具'), ('kjnode', 'KJ 工具'), ('dataset', '数据集'), ('lora_data', '数据集'), ('voxcpm', 'VoxCPM2'), ('music3', 'MiniMax Music3'), ('minimax', 'MiniMax H3 多阶段'), ('wan', 'Wan / HuMo'), ('qwen', 'Qwen Image'), ('flux', 'Flux'), ('sd3', 'SD3.5'), ('chroma', 'Chroma'), ('krea', 'Krea2'), ('ernie', 'ERNIE Image'), ('gemma', 'Gemma'), ('nb_api', 'Nano Banana'), ('ltx', 'LTX'), ('zimage', 'Z-Image'), ('z-image', 'Z-Image'), ('z_upscale', 'Z-Image')]:
        if pattern in low:
            return label
    return '其他工具'


def reachable(graph, output):
    keep, errors, visiting = set(), [], set()
    def visit(nid):
        if nid in visiting:
            errors.append('工作流包含循环连接：' + nid)
            return
        if nid in keep:
            return
        if nid not in graph:
            errors.append('连接目标不存在：' + nid)
            return
        keep.add(nid); visiting.add(nid)
        for value in graph[nid]['inputs'].values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int):
                visit(value[0])
        visiting.remove(nid)
    visit(output)
    return {k: v for k, v in graph.items() if k in keep}, errors


labels = {'width': '宽度', 'height': '高度', 'seed': '种子', 'noise_seed': '种子', 'steps': '步数', 'cfg': '引导强度', 'denoise': '重绘强度', 'text': '文本', 'value': '数值', 'duration': '时长', 'unet_name': '扩散模型', 'clip_name': '文本编码器', 'vae_name': 'VAE', 'model_name': '模型', 'lora_name': 'LoRA', 'filename_prefix': '输出前缀'}


def make_definition(name, raw, sha):
    wid = 'mirror-' + hashlib.sha256(name.encode()).hexdigest()[:16]
    output_file = wid + '.json'
    meta = {'file': name, 'sha256': sha, 'sourceUrl': '/mirror/workflows/' + output_file,
            'models': [], 'missingNodes': [], 'missingModels': [], 'issues': [], 'format': 'invalid'}
    base = {'id': wid, 'family': family(name), 'name': Path(name).stem, 'description': '镜像原始工作流 · ' + name,
            'mode': 'text-tool', 'promptRequired': False, 'requiredInputs': [], 'optionalInputs': [], 'parameters': [], 'mapping': [],
            'output': {'nodeId': '', 'field': 'text', 'kind': 'text'}, 'source': meta}
    try:
        source = clean(json.loads(raw))
    except Exception:
        meta['issues'] = ['镜像中的源文件为空或不是有效 JSON']
        return base, None
    graph = source.get('prompt', source)
    meta['format'] = 'ui' if isinstance(graph.get('nodes'), list) else 'api'
    references = sorted({s.replace('\\', '/').split('/')[-1] for s in strings(graph) if extension.search(s) and '\n' not in s})
    meta['models'] = references
    meta['missingModels'] = [m for m in references if m not in available]
    if meta['format'] == 'ui':
        graph, conversion = convert_ui(graph)
    else:
        graph = {str(k): v for k, v in graph.items() if isinstance(v, dict) and 'class_type' in v}
        conversion = {}
    training = any('Train' in n['class_type'] and 'Training' not in n['class_type'].replace('Training', '') for n in graph.values())
    # These files mix actual training with preview branches and remain excluded.
    training = training or 'trainer' in name.lower() or 'lora_train_sample' in name.lower() or '5_image-speedlora' in name.lower()
    meta['excluded'] = training
    if training:
        meta['issues'].append('按用户决定排除训练流程')
    meta['missingNodes'] = sorted({n['class_type'] for n in graph.values()} - set(schema))
    choices = []
    for nid, node in graph.items():
        kind = output_kind(node['class_type'])
        if not kind:
            continue
        subgraph, errors = reachable(graph, nid)
        if kind[0] == 'file':
            errors.append('该节点的输出文件格式需要适配：' + node['class_type'])
        if node['class_type'] in ('SaveImageKJ', 'SaveImageDataSetToFolder', 'SaveImageTextDataSetToFolder'):
            errors.append('原始目录保存节点需要适配到任务 output 目录：' + node['class_type'])
        for key in subgraph:
            errors.extend(conversion.get(key, []))
        choices.append({'nodeId': nid, 'field': kind[1], 'kind': kind[0], 'label': node.get('_meta', {}).get('title', node['class_type']) + ' · ' + nid,
                        'issues': sorted(set(errors))})
    if not choices:
        meta['issues'].append('原工作流未提供标准媒体或文本输出节点，需补输出适配')
        return base, source
    prefer_text = bool(re.search(r'prompt.?creator|transcrib|whipster|lyric|gemma|clearmemory', name, re.I))
    def output_rank(o):
        if base['family'] == '数据集' and graph[o['nodeId']]['class_type'].startswith('Save'):
            return -1
        if prefer_text and o['kind'] == 'text':
            return -1
        return {'video': 0, 'image': 1, 'audio': 2, 'text': 3, 'file': 4}[o['kind']]
    choices.sort(key=output_rank)
    chosen = choices[0]
    base['output'] = {k: chosen[k] for k in ('nodeId', 'field', 'kind')}
    base['outputChoices'] = choices
    # Keep the complete converted graph. Runtime takes only the selected output's ancestry.
    base['template'] = graph
    base['source']['nodeIssues'] = {k: v for k, v in conversion.items() if v}
    main_graph, _ = reachable(graph, chosen['nodeId'])
    prompt_candidates, inputs = [], collections.defaultdict(list)
    for nid, node in graph.items():
        typ = node['class_type']; specs = input_specs(typ)
        title = node.get('_meta', {}).get('title', typ)
        # Native preview output is persisted through /view as temp files as well.
        for field, value in list(node['inputs'].items()):
            if isinstance(value, list) or value is None or isinstance(value, dict):
                continue
            spec = specs.get(field, ['STRING' if isinstance(value, str) else 'BOOLEAN' if isinstance(value, bool) else 'FLOAT', {}])
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if field in ('image_paths', 'video_references') and typ in ('VRGDG_MultiReferenceConditioningFromPaths', 'VRGDG_MiniMaxH3ReferenceMediaFromPaths'):
                semantic = 'referenceImages' if field == 'image_paths' else 'referenceVideos'
                base['mapping'].append({'semantic': semantic, 'nodeId': nid, 'field': field, 'serialization': 'json-paths', 'maxItems': 9 if semantic == 'referenceImages' else 3})
                base['optionalInputs'].append(semantic); node['inputs'][field] = '[]'
                continue
            media = None
            if opts.get('image_upload') or (typ in ('LoadImage', 'VHS_LoadImagePath', 'Image Load') and field in ('image', 'image_path')):
                media = 'images'
            elif opts.get('video_upload') or (typ in ('VHS_LoadVideo', 'VHS_LoadVideoPath', 'LoadVideo') and field in ('video', 'file')):
                media = 'videos'
            elif opts.get('audio_upload') or (typ in ('LoadAudio', 'VHS_LoadAudio', 'VHS_LoadAudioUpload') and field in ('audio', 'audio_file')):
                media = 'audios'
            if media:
                inputs[media].append((nid, field, typ))
                node['inputs'][field] = ''
                continue
            key = 'input:' + nid + ':' + field
            options = spec[0] if isinstance(spec[0], list) else opts.get('options')
            param = {'key': key, 'label': labels.get(field, field), 'group': title + ' · ' + nid,
                     'type': 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'select' if options else 'text',
                     'default': value, 'advanced': True}
            if options:
                param['options'] = list(dict.fromkeys([str(value)] + [str(v) for v in options if isinstance(v, (str, int, float))]))
            for k in ('min', 'max', 'step', 'multiline'):
                if k in opts: param[k] = opts[k]
            if isinstance(value, str) and (extension.search(value) or re.search(r'(lora|unet|vae|clip|checkpoint|model)_?(name|\d+)?$', field, re.I)):
                param['model'] = True
            if isinstance(value, str) and '\n' in value:
                param['multiline'] = True
            if credential.search(field):
                param['default'] = ''; param['secret'] = True
            base['parameters'].append(param)
            base['mapping'].append({'semantic': key, 'nodeId': nid, 'field': field})
            if nid in main_graph and isinstance(value, str) and not re.match(r'^(?:[A-Za-z]:[\\/]|/root/|input/|output/)', value) and (field in ('prompt', 'positive_prompt', 'text', 'lyrics') or (typ.startswith('PrimitiveString') and field == 'value')):
                score = 10 if field in ('prompt', 'positive_prompt') else 8 if typ.startswith('PrimitiveString') else 6 if typ == 'CLIPTextEncode' else 1
                if re.search(r'negative|system|template|folder|directory|file.?path|srt|json|timestamp', title + ' ' + field, re.I): score = -1
                prompt_candidates.append((score, len(value), nid, field, key, value))
    for semantic, ports in inputs.items():
        base['requiredInputs'].append(semantic)
        for index, (nid, field, typ) in enumerate(ports):
            mapping = {'semantic': semantic, 'nodeId': nid, 'field': field, 'index': index}
            if typ in ('VHS_LoadAudio', 'VHS_LoadVideoPath', 'VHS_LoadImagePath', 'Image Load'):
                mapping['pathMode'] = 'comfy-input'
            base['mapping'].append(mapping)
    if prompt_candidates:
        candidate = max(prompt_candidates)
        if candidate[0] >= 0:
            _, _, nid, field, key, value = candidate
            base['mapping'] = [m for m in base['mapping'] if m['semantic'] != key]
            base['mapping'].append({'semantic': 'prompt', 'nodeId': nid, 'field': field})
            base['parameters'] = [p for p in base['parameters'] if p['key'] != key]
            base['defaultPrompt'] = value
            base['optionalInputs'].append('prompt')
    out = base['output']['kind']; media = set(inputs)
    base['mode'] = ('dataset' if base['family'] == '数据集' else 'text-to-video' if out == 'video' and not media else 'reference-video' if out == 'video' and 'videos' in media else 'image-to-video' if out == 'video' else 'image-to-image' if out == 'image' and media else 'text-to-image' if out == 'image' else 'audio-to-audio' if out == 'audio' and media else 'text-to-audio' if out == 'audio' else 'audio-to-text' if 'audios' in media else 'text-tool')
    return base, source


result = []
dest = root / 'public/mirror/workflows'
dest.mkdir(parents=True, exist_ok=True)
for name, raw in sorted(sources.items()):
    definition, source = make_definition(name, raw, hashlib.sha256(raw).hexdigest())
    if source is not None:
        (dest / (definition['id'] + '.json')).write_text(json.dumps(source, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    result.append(definition)
    for model in definition['source']['models']:
        matching = [m for m in models if m['name'] == model]
        if not matching:
            missing = {'path': '', 'name': model, 'category': '工作流引用 · 待准备', 'size': 0, 'available': False, 'symlink': False, 'workflows': []}
            models.append(missing); matching = [missing]
        for m in matching:
            m['workflows'].append(definition['id'])
summary = {'sourceFiles': len(result), 'excludedTraining': sum(bool(w['source'].get('excluded')) for w in result),
           'invalidFiles': sum(w['source']['format'] == 'invalid' for w in result),
           'apiFiles': sum(w['source']['format'] == 'api' for w in result),
           'uiFiles': sum(w['source']['format'] == 'ui' for w in result),
           'installedModelFiles': sum(m['available'] for m in models), 'referencedMissingModels': sum(not m['available'] for m in models)}
data = {'importedAt': '2026-09-24', 'summary': summary, 'workflows': result, 'models': models}
(root / 'src/workflow/mirror-data.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
(root / 'src/workflow/mirror-data.gz.json').write_text(json.dumps(base64.b64encode(gzip.compress(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode(), mtime=0)).decode()), encoding='utf-8')
(root / 'deploy/autodl/mirror-inventory.json').write_text(json.dumps({'importedAt': data['importedAt'], 'summary': summary, 'workflows': [{'id': w['id'], **w['source']} for w in result], 'models': models}, ensure_ascii=False, indent=2), encoding='utf-8')
model_options = {}
for typ in schema:
    for field, spec in input_specs(typ).items():
        opts = spec[0] if isinstance(spec[0], list) else spec[1].get('options', []) if len(spec) > 1 and isinstance(spec[1], dict) else []
        if any(isinstance(v, str) and extension.search(v) for v in opts):
            model_options[typ + '.' + field] = [v for v in opts if isinstance(v, str)]
(root / 'src/workflow/model-options.json').write_text(json.dumps(model_options, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
