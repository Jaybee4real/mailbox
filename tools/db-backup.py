#!/usr/bin/env python3
"""Back the mail database up to gzipped JSONL, one chunk at a time.

An embedded replica cannot bootstrap here: it wants a single uninterrupted 7.5GB
HTTP body and this link drops every half hour, so the transfer dies with
IncompleteBody. Paging by rowid instead means a dropped connection costs one chunk
rather than the whole run, and an interrupted night resumes where it stopped.

The full-text index is skipped. It is derived from mail_inbox and is rebuilt on
restore, so copying it would double the transfer to no purpose.
"""
import argparse, gzip, json, os, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import doh

doh.install()

DERIVED_PREFIX = 'mail_inbox_fts'


class ChunkTooLarge(Exception):
    """The response body was cut off. Retrying the same size just fails again."""
CHUNK = 200
MIN_CHUNK = 5


def load_env(path):
    for line in open(path, encoding='utf-8'):
        match = line.strip().split('=', 1)
        if len(match) == 2 and match[0] and not match[0].startswith('#'):
            os.environ.setdefault(match[0], match[1].strip('"').strip("'"))


def query(sql, args=None, attempts=9):
    host = (os.environ.get('DATABASE_URL') or os.environ['TURSO_DATABASE_URL']).replace('libsql://', 'https://').rstrip('/')
    stmt = {'sql': sql}
    if args:
        stmt['args'] = [{'type': 'text', 'value': str(a)} for a in args]
    body = json.dumps({'requests': [{'type': 'execute', 'stmt': stmt}, {'type': 'close'}]}).encode()
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(host + '/v2/pipeline', body, {
                'Authorization': 'Bearer ' + (os.environ.get('DATABASE_AUTH_TOKEN') or os.environ['TURSO_AUTH_TOKEN']),
                'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            result = payload['results'][0]
            if result.get('type') == 'error':
                raise RuntimeError(result['error']['message'][:200])
            out = result['response']['result']
            return [c['name'] for c in out['cols']], [[cell.get('value') for cell in row] for row in out['rows']]
        except Exception as err:
            last = err
            # A truncated body means the payload is too big for this link to carry in
            # one piece. Waiting does not help; a smaller chunk does.
            if 'IncompleteRead' in type(err).__name__ or 'IncompleteRead' in str(err):
                if attempt >= 1:
                    raise ChunkTooLarge(str(err)[:120])
            if attempt == attempts - 1:
                break
            time.sleep(min(60, 4 * (2 ** attempt)))
    raise RuntimeError(f'query failed after {attempts} attempts: {last}')


def table_names():
    _, rows = query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [r[0] for r in rows if not r[0].startswith(DERIVED_PREFIX)]


def dump_schema(out_dir):
    _, rows = query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    with open(os.path.join(out_dir, 'schema.sql'), 'w', encoding='utf-8') as handle:
        for kind, name, sql in rows:
            handle.write(f'-- {kind} {name}\n{sql};\n\n')
    return len(rows)


def export_table(name, out_dir, state):
    target = os.path.join(out_dir, f'{name}.jsonl.gz')
    done = state.get(name, {})
    if done.get('complete'):
        return done.get('rows', 0), True

    last_rowid = done.get('rowid', 0)
    written = done.get('rows', 0)
    mode = 'ab' if last_rowid else 'wb'
    # Rows here range from a few hundred bytes to a hundred kilobytes, so a fixed row
    # count produces wildly different payloads. A chunk large enough to be cut off
    # mid-body fails every retry identically, so shrink on failure and creep back up.
    size = CHUNK
    with gzip.open(target, mode) as handle:
        while True:
            try:
                cols, rows = query(
                    f'SELECT rowid AS _rowid, * FROM "{name}" WHERE rowid > {int(last_rowid)} ORDER BY rowid LIMIT {size}')
            except (ChunkTooLarge, RuntimeError):
                if size <= MIN_CHUNK:
                    raise
                size = max(MIN_CHUNK, size // 4)
                print(f'  {name}: chunk too big for the link, retrying at {size} rows', flush=True)
                continue
            if size < CHUNK:
                size = min(CHUNK, size * 2)
            if not rows:
                break
            for row in rows:
                record = dict(zip(cols, row))
                last_rowid = record.pop('_rowid')
                handle.write((json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8'))
                written += 1
            state[name] = {'rowid': last_rowid, 'rows': written, 'complete': False}
            save_state(out_dir, state)
    state[name] = {'rowid': last_rowid, 'rows': written, 'complete': True}
    save_state(out_dir, state)
    return written, False


def save_state(out_dir, state):
    tmp = os.path.join(out_dir, '.state.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(state, handle)
    os.replace(tmp, os.path.join(out_dir, '.state.json'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--env', default='.env.local')
    args = parser.parse_args()
    load_env(args.env)
    os.makedirs(args.out, exist_ok=True)

    state_path = os.path.join(args.out, '.state.json')
    state = json.load(open(state_path)) if os.path.exists(state_path) else {}

    objects = dump_schema(args.out)
    print(f'schema: {objects} objects', flush=True)

    total = 0
    for name in table_names():
        started = time.time()
        rows, skipped = export_table(name, args.out, state)
        total += rows
        note = 'already complete' if skipped else f'{time.time() - started:.0f}s'
        print(f'  {name:<24}{rows:>9} rows  ({note})', flush=True)

    manifest = {'finished_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'tables': {k: v['rows'] for k, v in state.items()}, 'total_rows': total,
                'note': 'full-text index omitted; rebuild after restore'}
    with open(os.path.join(args.out, 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
    print(f'total {total} rows', flush=True)


if __name__ == '__main__':
    main()
