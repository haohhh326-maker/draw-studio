"""Read-only checks for a candidate ComfyUI instance. No inference is submitted."""
import argparse
import json
import os
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--comfy-root', default='/root/ComfyUI')
parser.add_argument('--url', default='http://127.0.0.1:6006')
parser.add_argument('--origin', default='http://127.0.0.1:1420')
parser.add_argument('--files-only', action='store_true')
args = parser.parse_args()
directory = Path(__file__).resolve().parent
errors = []
for model in json.loads((directory / 'models.json').read_text(encoding='utf-8')):
    path = Path(args.comfy_root) / model['path']
    if not path.is_file():
        errors.append('Missing model: ' + model['path'])
    elif path.stat().st_size != model['size']:
        errors.append('Model size differs: ' + model['path'])

headers = {'Origin': args.origin}
if os.environ.get('COMFY_AUTHORIZATION'):
    headers['Authorization'] = os.environ['COMFY_AUTHORIZATION']

if not args.files_only:
    try:
        req = urllib.request.Request(args.url.rstrip('/') + '/system_stats', headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            allowed = response.headers.get('Access-Control-Allow-Origin')
            stats = json.load(response)
        if allowed not in ('*', args.origin):
            errors.append('CORS origin is not accepted: ' + str(allowed))
        req = urllib.request.Request(args.url.rstrip('/') + '/object_info', headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            schema = json.load(response)
        graphs = directory / 'recipes'
        manifest = directory / 'recipe-manifest.json'
        paths = [graphs / entry['file'] for entry in json.loads(manifest.read_text(encoding='utf-8'))['entries']] if manifest.exists() else list(graphs.glob('*.json'))
        required = {n['class_type'] for p in paths
                    for n in json.loads(p.read_text(encoding='utf-8')).values()}
        if not required:
            errors.append('Recipe files are missing')
        errors.extend('Missing node: ' + name for name in sorted(required - set(schema)))
        print(json.dumps({'version': stats.get('system', {}).get('comfyui_version'),
                          'cors': allowed, 'required_nodes': len(required)}, ensure_ascii=False))
    except Exception as exc:
        errors.append('API preflight failed: ' + type(exc).__name__)
print(json.dumps({'status': 'failed' if errors else 'passed', 'errors': errors,
                  'scope': 'Files, node registration and CORS only; no inference.'}, ensure_ascii=False, indent=2))
raise SystemExit(1 if errors else 0)
