"""Inventory actual mirror workflows, expanding embedded UI subgraphs.

No workflow is submitted. Registration is not treated as proof of execution.
"""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--workflows', required=True)
parser.add_argument('--schema', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--exclude-training', action='store_true', help='Retain training rows in the audit, but exclude them from the requested execution scope.')
args = parser.parse_args()
root = Path(args.workflows)
schema = json.loads(Path(args.schema).read_text(encoding='utf-8'))
ui_only = {'Note', 'MarkdownNote', 'Reroute', 'GetNode', 'SetNode',
           'PrimitiveNode', 'PrimitiveNodeValue', 'Seed Everywhere',
           'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)',
           'Power Puter (rgthree)', 'Image Comparer (rgthree)'}
model_extensions = ('.safetensors', '.gguf', '.ckpt', '.pt', '.pth')
available = set()
for node in schema.values():
    for section in ('required', 'optional'):
        for key, spec in node.get('input', {}).get(section, {}).items():
            if not spec:
                continue
            options = spec[0] if isinstance(spec[0], list) else spec[1].get('options', []) if len(spec) > 1 and isinstance(spec[1], dict) else []
            available.update(v.replace('\\', '/').split('/')[-1] for v in options
                             if isinstance(v, str) and v.lower().endswith(model_extensions))

def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)

rows = []
for path in sorted(root.rglob('*.json')):
    raw = path.read_bytes()
    row = {'file': path.relative_to(root).as_posix(), 'sha256': hashlib.sha256(raw).hexdigest()}
    try:
        workflow = json.loads(raw)
        graph = workflow.get('prompt', workflow)
        is_ui = isinstance(graph.get('nodes'), list)
        row['format'] = 'ui' if is_ui else 'api'
        definitions = {s['id']: s for s in graph.get('definitions', {}).get('subgraphs', [])}
        nodes = []
        virtual = set()
        def walk(items, stack=()):
            for n in items:
                name = n.get('type', n.get('class_type'))
                if name in definitions:
                    if name in stack:
                        raise ValueError('Recursive subgraph: ' + name)
                    walk(definitions[name].get('nodes', []), stack + (name,))
                elif name in ui_only:
                    virtual.add(name)
                elif name:
                    nodes.append(n)
        walk(graph['nodes'] if is_ui else [n for n in graph.values() if isinstance(n, dict)])
        types = sorted({n.get('type', n.get('class_type')) for n in nodes})
        model_names = sorted({v.replace('\\', '/').split('/')[-1]
                              for n in nodes for v in strings(n.get('widgets_values', n.get('inputs', {})))
                              if v.lower().endswith(model_extensions)})
        missing_types = sorted(set(types) - set(schema))
        missing_models = sorted(set(model_names) - available)
        name = row['file'].lower()
        category = ('dataset' if re.search(r'dataset|lora_data', name)
                    else 'training' if re.search(r'train', name) or any('Train' in t for t in types)
                    else 'audio' if re.search(r'music3|voxcpm|tts', name)
                    else 'tool' if re.search(r'transcrib|prompt.?creator|clearmemory|whipster|lyric|facefix|upscale|enhance', name)
                    else 'generation')
        row.update(category=category, node_count=len(nodes), node_types=types,
                   embedded_subgraphs=len(definitions), virtual_nodes=sorted(virtual),
                   missing_nodes=missing_types, referenced_models=model_names,
                   missing_models=missing_models,
                   status='dependencies-missing' if missing_types or missing_models else 'not-executed',
                   requires_ui_conversion=is_ui)
        row['in_scope'] = not (args.exclude_training and category == 'training')
        if not row['in_scope']:
            row['scope_reason'] = 'User cancelled LoRA training on 2026-09-23; dataset preparation remains in scope.'
    except Exception as exc:
        row.update(format='invalid', category='invalid', status='invalid', error=str(exc), in_scope=True)
    rows.append(row)
result = {'summary': {'total': len(rows), 'in_scope': sum(r['in_scope'] for r in rows), 'formats': dict(collections.Counter(r['format'] for r in rows)),
                      'categories': dict(collections.Counter(r['category'] for r in rows)),
                      'status': dict(collections.Counter(r['status'] for r in rows))},
          'scope': 'All source JSON files including historical/training/tool versions. Dependency inventory only; no inference. Model checks match installed basenames, not precision or architecture substitutions.',
          'workflows': rows}
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result['summary'], ensure_ascii=False, indent=2))
