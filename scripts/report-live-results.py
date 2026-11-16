"""Summarize real test evidence without shipping task snapshots or credentials."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
rows = []
failures = []
for path in sorted((root / 'live-results').glob('*/task.json')):
    task = json.loads(path.read_text(encoding='utf-8'))
    acceptance = path.parent / 'acceptance.json'
    if not acceptance.exists():
        failures.append({'case': path.parent.name, 'workflowId': task.get('workflow', {}).get('id'),
                         'promptId': task.get('promptId'), 'status': task.get('status'),
                         'error': task.get('error'), 'details': task.get('details')})
        continue
    result = json.loads(acceptance.read_text(encoding='utf-8'))
    media = list(path.parent.glob('result.*'))
    if result.get('status') != 'passed' or len(media) != 1:
        raise ValueError('Invalid evidence: ' + str(path.parent))
    content = media[0].read_bytes()
    if len(content) != result['bytes'] or not result['offlineReload'] or result['submissions'] != 1:
        raise ValueError('Incomplete evidence: ' + str(path.parent))
    rows.append({**result, 'workflowId': task['workflow']['id'], 'name': task['workflow']['name'],
                 'kind': task['workflow']['output']['kind'], 'case': path.parent.name,
                 'sha256': hashlib.sha256(content).hexdigest(), 'parameters': task['input']['params']})
report = {'scope': 'Real browser-to-ComfyUI tests with one submission, download, original-node writeback, and offline reload. Small acceptance fixtures, not quality or long-duration stress tests.',
          'passed_workflows': len({r['workflowId'] for r in rows}), 'passed_runs': len(rows),
          'results': rows, 'unsuccessful_runs': failures}
(root / 'deploy/autodl/live-acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
lines = ['# 云端真实验收记录', '',
         '每条通过记录均验证：画布提交一次 → 云端执行 → 下载本地 → 原节点回写 → 阻断云端后刷新仍能读取结果。',
         '使用短时、低分辨率测试素材；不代表所有参数组合、成片质量或长时间连续运行已验收。', '',
         f'已通过 {report["passed_workflows"]} 个不同配方，共 {len(rows)} 次。训练流程按用户 2026-09-23 的决定取消，数据集和工具仍在范围内。', '',
         '| 配方 | 输出 | 时长/秒 | 大小/字节 | promptId |', '| --- | --- | ---: | ---: | --- |']
for r in rows:
    lines.append(f'| {r["name"]} | {r["kind"]} | {r.get("duration", "—")} | {r["bytes"]} | `{r["promptId"]}` |')
lines += ['', '## 未成功的试跑', '']
for r in failures:
    lines.append(f'- `{r["workflowId"]}` / `{r["promptId"]}`：{r["status"]}，{r.get("error") or "见本地任务快照"}。保留失败证据，不计入通过数。')
lines += ['', '完整参数和媒体 SHA-256 见 `deploy/autodl/live-acceptance.json`；本地原始证据位于 `live-results/<case>/`，未打包进源码归档。', '']
(root / 'LIVE-ACCEPTANCE.md').write_text('\n'.join(lines), encoding='utf-8')
print(f'Passed workflows: {report["passed_workflows"]}; unsuccessful runs: {len(failures)}')
