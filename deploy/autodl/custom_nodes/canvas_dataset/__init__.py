"""Dataset output through standard ComfyUI /prompt, /history and /view APIs."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import uuid
import zipfile

import folder_paths


def inside(root, value):
    if not isinstance(value, str) or not value or any(c in value for c in ('\\', ':', '\x00')):
        raise ValueError('Only relative input/output paths are accepted')
    parts = value.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('Unsafe dataset path')
    root = Path(root).resolve()
    path = (root / value).resolve()
    if os.path.commonpath([str(path), str(root)]) != str(root):
        raise ValueError('Dataset path escapes its directory')
    return path


class CanvasDatasetBundle:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'image_paths': ('STRING', {'default': '[]'}),
            'caption': ('STRING', {'default': '', 'multiline': True}),
            'captions': ('STRING', {'default': '', 'multiline': True}),
            'filename_prefix': ('STRING', {'default': 'canvas/dataset'}),
        }}

    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('dataset_file',)
    FUNCTION = 'bundle'
    CATEGORY = 'Canvas/Dataset'
    OUTPUT_NODE = True

    def bundle(self, image_paths, caption, captions, filename_prefix):
        paths = json.loads(image_paths)
        if not isinstance(paths, list) or not 1 <= len(paths) <= 64:
            raise ValueError('A dataset needs 1 to 64 images')
        labels = captions.splitlines() if captions.strip() else [caption] * len(paths)
        if len(labels) != len(paths) or any(not label.strip() for label in labels):
            raise ValueError('Please provide a shared caption or one nonempty caption per image')
        inputs = [inside(folder_paths.get_input_directory(), value) for value in paths]
        for path in inputs:
            if not path.is_file() or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}:
                raise ValueError('Dataset inputs must be existing PNG/JPG/WEBP/BMP files')
        output_root = Path(folder_paths.get_output_directory()).resolve()
        target = inside(output_root, filename_prefix + '-' + uuid.uuid4().hex[:8] + '.zip')
        target.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.dataset-', suffix='.tmp', dir=target.parent)
        os.close(handle)
        manifest = []
        try:
            with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED) as archive:
                for index, (path, label) in enumerate(zip(inputs, labels), 1):
                    stem = f'{index:04d}'
                    name = stem + path.suffix.lower()
                    archive.write(path, 'images/' + name)
                    archive.writestr('images/' + stem + '.txt', label.strip() + '\n')
                    digest = hashlib.sha256()
                    with path.open('rb') as source:
                        for block in iter(lambda: source.read(1024 * 1024), b''):
                            digest.update(block)
                    manifest.append({'image': 'images/' + name, 'caption': label.strip(), 'sha256': digest.hexdigest()})
                archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        relative = target.relative_to(output_root)
        return {'ui': {'files': [{'filename': target.name, 'subfolder': str(PurePosixPath(*relative.parts[:-1])) if len(relative.parts) > 1 else '', 'type': 'output'}]},
                'result': (str(relative),)}


NODE_CLASS_MAPPINGS = {'CanvasDatasetBundle': CanvasDatasetBundle}
