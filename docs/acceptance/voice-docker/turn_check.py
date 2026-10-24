"""容器内验收：用本机设备令牌走设备面，一次真实语音文本轮 + 凭证。

在容器里跑（令牌不出容器，只打印结果）：
  docker exec -i charlie python3 - < docs/acceptance/voice-docker/turn_check.py
"""

import json
import os
import time
import urllib.request

BASE = 'http://127.0.0.1:7788'


def load_env(path):
    out = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k] = v.strip()
    return out


def call(method, path, token, body=None, timeout=150):
    data = None if body is None else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json'},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read().decode('utf-8')
        return res.status, json.loads(raw), round((time.time() - t0) * 1000)


dev = load_env('/data/voice/device.env')
device_token = dev['DOTD_DEVICE_TOKEN']
master = os.environ['DOTD_MASTER_TOKEN']

TEXT = os.environ.get('TURN_TEXT') or (
    '把这件事记到长期记忆里：这台机器是 Docker 部署的验收环境。'
    '做法：调用 fs.write 写入 notes/2026-10-23-docker-accept.md（一条即可），然后回复一句确认。'
)

status, submitted, submit_ms = call('POST', '/api/device/turn', device_token, {'text': TEXT})
task_id = submitted.get('taskId')
print('submit', json.dumps({'status': status, 'ms': submit_ms, 'taskId': task_id,
                            'deviceId': submitted.get('deviceId'),
                            'threadId': submitted.get('threadId')}, ensure_ascii=False))

terminal = {'done', 'failed', 'cancelled', 'awaiting_approval', 'paused'}
deadline = time.time() + 200
last = {}
started = time.time()
while time.time() < deadline:
    _, body, _ = call('GET', '/api/device/tasks/' + task_id, device_token)
    last = body
    if (body.get('task') or {}).get('status') in terminal:
        break
    time.sleep(1.0)

elapsed_ms = round((time.time() - started) * 1000)
task = last.get('task') or {}
print('turn', json.dumps({
    'status': task.get('status'),
    'elapsedMs': elapsed_ms,
    'reply': last.get('reply'),
    'stateLine': (last.get('summary') or {}).get('stateLine'),
}, ensure_ascii=False))

status, proof, proof_ms = call('GET', '/api/tasks/' + task_id + '/proof', master)
steps = proof.get('steps') if isinstance(proof, dict) else None
print('proof', json.dumps({
    'http': status,
    'ms': proof_ms,
    'bundleHash': proof.get('bundleHash') if isinstance(proof, dict) else None,
    'device': proof.get('device') if isinstance(proof, dict) else None,
    'stepCount': len(steps) if isinstance(steps, list) else None,
    'steps': [{k: s.get(k) for k in ('tool', 'status', 'argsHash', 'resultHash')}
              for s in (steps or [])][:6],
}, ensure_ascii=False))
