"""Prepare a resumable HU embedding cache without modifying the live Wiki.

Run on the cloud host. Credentials are read locally and never printed.
The apply phase is intentionally separate from online preparation.
"""
import argparse
import base64
from contextlib import ExitStack
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import struct
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import yaml

def deploy_config():
    """Site values from edmore.deploy.env (see edmore.deploy.env.example)."""
    path = Path(os.environ.get('EDMORE_DEPLOY_ENV', Path.home() / '.config/edmore/deploy.env'))
    if not path.is_file():
        raise SystemExit(f'Missing deployment config: {path}')
    output = subprocess.run(['bash', '-c', 'set -a; source "$1"; env -0', '_', str(path)],
                            check=True, capture_output=True).stdout.decode()
    return dict(row.split('=', 1) for row in output.split('\0') if '=' in row)


DEPLOY = deploy_config()
BASE = Path(DEPLOY['EDMORE_OPS_ROOT'])
WIKI = Path(DEPLOY['EDMORE_WIKI_DATA_DIR'])
STATE = WIKI / 'hu-migration'
EMBEDDING = 'edmore-hu-embedding'
TEXT = 'edmore-hu-text'
VISION = 'edmore-hu-vision'
RERANK = 'edmore-hu-rerank'
MODEL_MAP = {
    '2c5e4be3-5877-4282-80f6-24d03baec5f1': EMBEDDING,
    'edmore-wiki-embedding': EMBEDDING,
    '6b9edf38-9491-40af-aa15-56076c3f78d7': TEXT,
    'edmore-wiki-synthesis': TEXT,
}


def hu_key():
    home = BASE / 'edmore-data/edmore'
    profiles = json.loads((home / 'llm-providers.json').read_text())['profiles']
    profile = next(p for p in profiles if p['id'] == 'llm3-hu')
    return yaml.safe_load((home / '.credentials.yaml').read_text())['refs'][profile['apiKeyEnv']]


def call(url, body=None, key=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    request = urllib.request.Request(url, headers=headers, method=method,
                                     data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def source():
    return sqlite3.connect('file:' + str(WIKI / 'weknora.db') + '?mode=ro', uri=True)


def digest(content):
    return hashlib.sha256(content.encode()).hexdigest()


def cache():
    STATE.mkdir(mode=0o700, exist_ok=True)
    connection = sqlite3.connect(str(STATE / 'vectors.db'))
    connection.execute('CREATE TABLE IF NOT EXISTS vectors (hash TEXT PRIMARY KEY, vector BLOB NOT NULL)')
    return connection


def prepare():
    db = source()
    entries = db.execute('SELECT DISTINCT content FROM lite_embeddings ORDER BY id').fetchall()
    db.close()
    cached = cache()
    known = {row[0] for row in cached.execute('SELECT hash FROM vectors')}
    todo = [(digest(row[0]), row[0]) for row in entries if digest(row[0]) not in known]
    # Matches the current indexer's input for this snapshot. Fail rather than
    # silently embedding image payloads or differently truncated content.
    assert all('base64,' not in content and len(content) < 10000 for _, content in todo)
    key = hu_key()
    print(json.dumps({'distinct_inputs': len(entries), 'remaining': len(todo)}), flush=True)
    for start in range(0, len(todo), 128):
        batch = todo[start:start + 128]
        for attempt in range(5):
            try:
                result = call('https://llm5-compute.cms.hu-berlin.de/v1/embeddings',
                              {'model': 'llm5', 'input': [content for _, content in batch],
                               'encoding_format': 'base64'}, key)
                break
            except urllib.error.HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                    raise RuntimeError('HU embedding HTTP ' + str(error.code)) from None
                time.sleep(10 * (attempt + 1))
        rows = sorted(result['data'], key=lambda item: item['index'])
        assert [r['index'] for r in rows] == list(range(len(batch)))
        for (hash_value, _), row in zip(batch, rows):
            blob = base64.b64decode(row['embedding'], validate=True)
            vector = struct.unpack('<4096f', blob)
            assert len(vector) == 4096 and all(math.isfinite(v) for v in vector)
            assert any(v != 0 for v in vector)
            cached.execute('INSERT OR REPLACE INTO vectors VALUES (?, ?)',
                           (hash_value, blob))
        cached.commit()
        print(json.dumps({'prepared': min(start + len(batch), len(todo)), 'total': len(todo)}), flush=True)
        time.sleep(4.1)
    cached.close()


def replace_ids(value):
    if isinstance(value, dict):
        return {k: replace_ids(v) for k, v in value.items()}
    if isinstance(value, list):
        return [replace_ids(v) for v in value]
    if isinstance(value, str):
        return MODEL_MAP.get(value, value)
    return value


def configure_models():
    key = hu_key()
    entries = []
    for id_, type_, endpoint in [(EMBEDDING, 'Embedding', 5), (TEXT, 'KnowledgeQA', 3),
                                 (VISION, 'VLLM', 3), (RERANK, 'Rerank', 6)]:
        parameters = {'provider': 'generic', 'interface_type': 'openai',
                      'base_url': f'https://llm{endpoint}-compute.cms.hu-berlin.de/v1',
                      'api_key': key, 'max_concurrency': 1}
        if type_ == 'Embedding':
            parameters['embedding_parameters'] = {'dimension': 4096, 'truncate_prompt_tokens': 32767}
        if endpoint == 3:
            parameters['supports_vision'] = True
        entries.append({'id': id_, 'name': f'llm{endpoint}', 'type': type_,
                        'source': 'remote', 'status': 'active',
                        'description': 'HU-hosted EDMORE Wiki model', 'parameters': parameters})
    return {'builtin_models': entries}


def configure_runtime():
    settings = json.loads((WIKI / 'provision.json').read_text())
    root = 'http://127.0.0.1:8080/api/v1'
    token = call(root + '/auth/login', {'email': settings['email'], 'password': settings['password']})['token']
    endpoint = root + '/system/admin/settings/ssrf.whitelist'
    existing = call(endpoint, key=token)['value']
    assert isinstance(existing, list)
    hosts = [f'llm{n}-compute.cms.hu-berlin.de' for n in (3, 5, 6)]
    updated = list(dict.fromkeys(existing + hosts))
    call(endpoint, {'value': updated}, token, 'PUT')
    print(json.dumps({'hu_allowlisted_hosts': hosts}), flush=True)


def apply_offline():
    with ExitStack() as resources:
        _apply_offline(resources)


def _apply_offline(resources):
    # Hold both deployment locks: no job may restart while references and the
    # vector index are being changed. The caller must first stop its Slurm job.
    for path in [BASE / 'edmore-data/server.lock', WIKI / 'server.lock']:
        lock = resources.enter_context(path.open('a'))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for port in (7380, 8080):
        with socket.socket() as sock:
            assert sock.connect_ex(('127.0.0.1', port)) != 0, 'Service still running'
    sys.path.insert(0, str(BASE / 'weknora/migration-libs'))
    import sqlite_vec
    db = sqlite3.connect(str(WIKI / 'weknora.db'))
    resources.callback(db.close)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    assert db.execute('SELECT vec_version()').fetchone()[0] == 'v0.1.6'
    assert db.execute('SELECT count(*) FROM memory_item_embeddings').fetchone()[0] == 0
    rows = db.execute('SELECT id, content, dimension FROM lite_embeddings ORDER BY id').fetchall()
    assert rows and all(row[2] == 1536 for row in rows), 'Unexpected source dimensions'
    cached = cache()
    resources.callback(cached.close)
    vectors = dict(cached.execute('SELECT hash, vector FROM vectors'))
    assert all(digest(content) in vectors for _, content, _ in rows), 'Run prepare again: sources changed'
    assert all(len(vectors[digest(content)]) == 4096 * 4 for _, content, _ in rows)
    backup = STATE / ('backup-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    target = sqlite3.connect(str(backup / 'weknora.db'))
    db.backup(target)
    target.close()
    paths = [WIKI / 'builtin-models.yaml', WIKI / 'provision.json']
    for path in paths:
        shutil.copy2(path, backup / path.name)
    provision = json.loads(paths[1].read_text())
    provision['personalModels'] = {'embedding': EMBEDDING, 'synthesis': TEXT,
                                   'vision': VISION, 'rerank': RERANK}
    configs = [yaml.safe_dump(configure_models(), sort_keys=False), json.dumps(provision, indent=2) + '\n']
    try:
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE VIRTUAL TABLE vec_embeddings_4096 USING vec0(embedding float[4096] distance_metric=cosine)')
        db.executemany('INSERT INTO vec_embeddings_4096(rowid, embedding) VALUES (?, ?)',
                       ((id_, vectors[digest(content)]) for id_, content, _ in rows))
        db.execute('UPDATE lite_embeddings SET dimension=4096')
        for table, column in [('knowledge_bases', 'embedding_model_id'), ('knowledge_bases', 'summary_model_id'),
                              ('knowledges', 'embedding_model_id'), ('sessions', 'summary_model_id')]:
            for old, new in MODEL_MAP.items():
                db.execute(f'UPDATE {table} SET {column}=? WHERE {column}=?', (new, old))
        json_columns = {
            'knowledge_bases': ['wiki_config', 'vlm_config', 'image_processing_config'],
            'tenants': ['retrieval_config', 'conversation_config', 'agent_config', 'chat_history_config', 'memory_config'],
            'sessions': ['agent_config'], 'custom_agents': ['config'],
        }
        for table, columns in json_columns.items():
            for row in db.execute(f'SELECT rowid,{",".join(columns)} FROM {table}').fetchall():
                updates = []
                for column, raw in zip(columns, row[1:]):
                    value = replace_ids(json.loads(raw)) if raw else {}
                    if table == 'knowledge_bases' and column == 'vlm_config':
                        value.update(enabled=True, model_id=VISION, description_language='en-US')
                    if table == 'knowledge_bases' and column == 'image_processing_config':
                        value['model_id'] = VISION
                    if table == 'tenants' and column == 'retrieval_config':
                        value.update(rerank_model_id=RERANK, rerank_threshold=0.0)
                    # WeKnora's GORM Scanner expects []byte, not SQLite TEXT.
                    updates.append(json.dumps(value).encode())
                db.execute(f'UPDATE {table} SET ' + ','.join(c + '=?' for c in columns) + ' WHERE rowid=?',
                           updates + [row[0]])
        for old in MODEL_MAP:
            db.execute('UPDATE models SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', (old,))
        assert db.execute('SELECT count(*) FROM vec_embeddings_4096').fetchone()[0] == len(rows)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        for path, content in zip(paths, configs):
            temporary = path.with_suffix(path.suffix + '.hu-new')
            temporary.write_text(content)
            temporary.chmod(0o600)
            temporary.replace(path)
        db.commit()
    except BaseException:
        db.rollback()
        for path in paths:
            shutil.copy2(backup / path.name, path)
        raise
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    manifest = {'backup': str(backup), 'vectors': len(rows), 'dimension': 4096,
                'models': [EMBEDDING, TEXT, VISION, RERANK]}
    (STATE / 'applied.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'apply-offline', 'configure-runtime'])
    args = parser.parse_args()
    if args.phase == 'prepare':
        prepare()
    elif args.phase == 'apply-offline':
        apply_offline()
    else:
        configure_runtime()
