"""Verify HU models through WeKnora, not just the upstream endpoints."""
import importlib.util
import json
from pathlib import Path
import struct
import time
import urllib.request
import uuid
import zlib

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-cloud-wiki-hu.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ROOT = 'http://127.0.0.1:8080/api/v1'


def png_chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)


def debug(token, model_id, fields, image=None):
    boundary = 'wiki-hu-' + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    if image:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="red.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + image + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    req = urllib.request.Request(ROOT + '/models/' + model_id + '/debug', data=b''.join(parts),
                                 headers={'Authorization': 'Bearer ' + token,
                                          'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urllib.request.urlopen(req, timeout=180) as response:
        data = json.load(response)['data']
    report = {'model': model_id, 'ok': data.get('ok'), 'elapsed_ms': data.get('elapsed_ms'),
              'observations': data.get('observations'), 'error': data.get('error')}
    if model_id in (m.TEXT, m.VISION):
        report['answer'] = data.get('raw_response')
    print(json.dumps(report), flush=True)
    assert data.get('ok'), report
    return report


def verify():
    settings = json.loads((m.WIKI / 'provision.json').read_text())
    token = m.call(ROOT + '/auth/login', {'email': settings['email'], 'password': settings['password']})['token']
    models = m.call(ROOT + '/models', key=token)['data']
    assert {row['id'] for row in models} == {m.TEXT, m.VISION, m.EMBEDDING, m.RERANK}
    print(json.dumps({'active_models': [{'id': row['id'], 'name': row['name'], 'type': row['type']} for row in models]}), flush=True)
    image = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('!2I5B', 128, 128, 8, 2, 0, 0, 0))
    image += png_chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 128) * 128)) + png_chunk(b'IEND', b'')
    reports = []
    reports.append(debug(token, m.TEXT, {'input': 'Reply with exactly: HU Wiki is ready.', 'options': '{"max_tokens":32,"thinking":false}'}))
    time.sleep(4.1)
    reports.append(debug(token, m.VISION, {'input': 'What is the solid color? Answer with one English word.'}, image))
    time.sleep(4.1)
    reports.append(debug(token, m.EMBEDDING, {'input': 'Electron microscope alignment'}))
    time.sleep(4.1)
    reports.append(debug(token, m.RERANK, {'input': 'electron microscopy alignment',
                                         'documents': json.dumps(['Align the electron beam.', 'Bake a cake.'])}))
    state = json.loads((m.BASE / 'edmore-data/auth/wiki/zhaomeng.native.json').read_text())
    identity = state['identity']
    user = m.call(ROOT + '/auth/login', {'email': identity['email'], 'password': identity['password']})['token']
    own = m.call(ROOT + '/knowledge-bases', key=user)['data']
    assert all(row['tenant_id'] == state['tenantId'] for row in own)
    assert all(row['embedding_model_id'] == m.EMBEDDING for row in own)
    shared = m.call(ROOT + '/shared-knowledge-bases', key=user)
    assert state['sharedKnowledgeBaseId'] in json.dumps(shared)
    result = m.call(ROOT + '/knowledge-search',
                    {'query': 'TEM Twin alignment sequence', 'knowledge_base_ids': [state['sharedKnowledgeBaseId']], 'match_count': 5}, user)
    assert result.get('data'), 'Shared retrieval returned no passages'
    report = {'private_kbs': len(own), 'shared_visible': True, 'search_results': len(result['data']), 'meta': result.get('meta')}
    print(json.dumps(report), flush=True)
    reports.append(report)
    (m.STATE / 'verified.json').write_text(json.dumps(reports, indent=2) + '\n')


if __name__ == '__main__':
    verify()
