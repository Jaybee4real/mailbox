#!/usr/bin/env python3
"""Stream an mbox archive into the mailbox tables.

Runs in constant memory: messages are split off the file one at a time and written in
small chunks. Row ids derive from Message-ID, and every chunk checks which ids already
exist before uploading anything, so a re-run — or a crash and restart — never duplicates
a row or a blob.

Gmail labels drive routing: Spam and Drafts are skipped, Sent goes to the sent folder,
Trash and Starred become flags, and anything without an Inbox label is archived.
"""

import argparse
import concurrent.futures
import email
import email.utils
import datetime
import hashlib
import hmac
import json
import secrets
import os
import re
import socket
import sys
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timezone
from email.header import decode_header, make_header

BLOB_LIMIT_BYTES = 20 * 1024 * 1024

# A home router whose resolver flaps takes every request down with it while raw IP
# connectivity is fine. When the system resolver fails, ask 1.1.1.1 by address over
# HTTPS instead — scoped to this process, so nothing on the machine is changed.
_system_getaddrinfo = socket.getaddrinfo
_doh_cache = {}


def _doh_lookup(host):
    request = urllib.request.Request(
        f'https://1.1.1.1/dns-query?name={urllib.parse.quote(host)}&type=A',
        headers={'accept': 'application/dns-json'},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        answers = json.load(response).get('Answer') or []
    addresses = [entry['data'] for entry in answers if entry.get('type') == 1]
    if not addresses:
        raise socket.gaierror(f'no A record for {host} via DoH')
    return addresses


def _resilient_getaddrinfo(host, port, family=0, kind=0, proto=0, flags=0):
    try:
        return _system_getaddrinfo(host, port, family, kind, proto, flags)
    except socket.gaierror:
        if host in ('1.1.1.1',) or not isinstance(host, str):
            raise
        if host not in _doh_cache:
            _doh_cache[host] = _doh_lookup(host)
            print(f'  ~ system DNS failed for {host}; using DoH answer {_doh_cache[host][0]}', flush=True)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (address, port))
                for address in _doh_cache[host]]


socket.getaddrinfo = _resilient_getaddrinfo
BODY_CAP = 4_000_000
INBOX_COLUMNS = ('id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, headers, '
                 'received_at, read, attachments, owner, starred, archived, trashed, labels')
INSERT_INBOX = (f'INSERT INTO mail_inbox ({INBOX_COLUMNS}) VALUES ({",".join("?" * 18)}) '
                'ON CONFLICT (id) DO NOTHING')
INSERT_SENT = ('INSERT INTO mail_sent (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, body_text, '
               'created_at, last_event, provider, attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
INSERT_SENT_META = ('INSERT INTO mail_sent_meta (email_id, owner, is_auto, created_at) VALUES (?,?,0,?) '
                    'ON CONFLICT (email_id) DO NOTHING')


def messages(path):
    """Yield raw message bytes. Takeout escapes body 'From ' lines, so the bare form is a boundary.
    A path of '-' reads the mbox from stdin, so a zip can be streamed in without extracting it."""
    buffer = bytearray()
    handle = sys.stdin.buffer if path == '-' else open(path, 'rb')
    with handle:
        for line in handle:
            if line.startswith(b'From '):
                if buffer:
                    yield bytes(buffer)
                buffer = bytearray()
                continue
            buffer += line
    if buffer:
        yield bytes(buffer)


def decoded(value):
    if not value:
        return ''
    try:
        return str(make_header(decode_header(str(value))))
    except Exception:
        return str(value)


def addresses(message, header):
    found = []
    for raw in message.get_all(header, []):
        for _, address in email.utils.getaddresses([str(raw)]):
            if address:
                found.append(address.lower())
    return found


def received_at(message):
    raw = message.get('Date')
    if not raw:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(str(raw))
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def bodies(message, keep_bytes=True):
    html, text, attachments = None, None, []
    for part in (message.walk() if message.is_multipart() else [message]):
        if part.get_content_maintype() == 'multipart':
            continue
        filename = part.get_filename()
        disposition = str(part.get('Content-Disposition') or '')
        if filename or 'attachment' in disposition.lower():
            raw = b''
            if keep_bytes:
                try:
                    raw = part.get_payload(decode=True) or b''
                except Exception:
                    raw = b''
            attachments.append({
                'filename': decoded(filename) or 'attachment',
                'contentType': part.get_content_type(),
                'size': len(raw),
                'bytes': raw,
            })
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            continue
        if payload is None:
            continue
        charset = part.get_content_charset() or 'utf-8'
        try:
            body = payload.decode(charset, errors='replace')
        except LookupError:
            body = payload.decode('utf-8', errors='replace')
        if part.get_content_type() == 'text/html' and html is None:
            html = body[:BODY_CAP]
        elif part.get_content_type() == 'text/plain' and text is None:
            text = body[:BODY_CAP]
    return html, text, attachments


def row_for(message, owner, force_read, keep_bytes=True):
    message_id = str(message.get('Message-ID') or '').strip()
    seed = message_id or '|'.join([
        str(message.get('Date') or ''), str(message.get('From') or ''), str(message.get('Subject') or ''),
    ])
    labels = [label.strip() for label in str(message.get('X-Gmail-Labels') or '').split(',') if label.strip()]
    sender = addresses(message, 'From')
    from_addr = sender[0] if sender else decoded(message.get('From'))
    is_sent = 'Sent' in labels or (bool(sender) and sender[0] == owner)
    html, text, attachments = bodies(message, keep_bytes)
    primary_id = 'mbox-' + hashlib.sha256(seed.encode('utf-8', 'replace')).hexdigest()[:28]
    return {
        'id': primary_id,
        'primary_id': primary_id,
        'alt_id': 'mbox-' + hashlib.sha256((seed + '|' + owner).encode('utf-8', 'replace')).hexdigest()[:28],
        'kind': 'skip' if ('Spam' in labels or 'Drafts' in labels) else ('sent' if is_sent else 'inbox'),
        'from': from_addr,
        'to': addresses(message, 'To') or addresses(message, 'Delivered-To'),
        'cc': addresses(message, 'Cc'),
        'bcc': addresses(message, 'Bcc'),
        'replyTo': addresses(message, 'Reply-To'),
        'subject': decoded(message.get('Subject')),
        'html': html,
        'text': text,
        'headers': {'message-id': message_id, 'x-gmail-labels': ','.join(labels),
                    'date': str(message.get('Date') or ''), 'imported-from': 'mbox'},
        'receivedAt': received_at(message),
        'read': True if force_read else ('Unread' not in labels),
        'attachments': attachments,
        'owner': owner,
        'labels': labels,
        'starred': 'Starred' in labels,
        'trashed': 'Trash' in labels,
        'archived': 'Inbox' not in labels and 'Trash' not in labels and not is_sent,
    }


RETRY_DELAYS = (5, 10, 20, 40, 60, 90, 120, 180, 300)


def transient(err):
    """A dropped network, DNS failure, timeout, or a 429/5xx from the service — not a bad statement."""
    if isinstance(err, urllib.error.HTTPError):
        return err.code == 429 or err.code >= 500
    return isinstance(err, (urllib.error.URLError, OSError, TimeoutError))


def with_retry(action, label):
    for attempt, delay in enumerate(RETRY_DELAYS + (None,)):
        try:
            return action()
        except Exception as err:
            if delay is None or not transient(err):
                raise
            print(f'  ~ {label}: {str(err)[:80]} — retry {attempt + 1} in {delay}s', flush=True)
            time.sleep(delay)


class UploadBudget:
    """Leaky-bucket schedule shared by every upload thread: each upload reserves the time
    its bytes take at the cap and waits for its slot, so the aggregate never exceeds the cap
    and downloads (the importer's own database replies included) are not starved."""

    def __init__(self, mbps):
        self.bytes_per_second = mbps * 1_000_000 / 8 if mbps else None
        self.next_slot = time.monotonic()
        self.lock = threading.Lock()

    def reserve(self, size):
        if not self.bytes_per_second:
            return
        with self.lock:
            now = time.monotonic()
            # Never let the schedule drift more than a minute ahead of the clock: failed
            # attempts and clock hiccups would otherwise park every uploader asleep.
            start = min(max(now, self.next_slot), now + 60)
            self.next_slot = start + size / self.bytes_per_second
        wait = start - now
        if wait > 0:
            time.sleep(wait)


UPLOAD_BUDGET = UploadBudget(None)


class S3Store:
    """S3-API object store (Cloudflare R2 or AWS S3) signed with SigV4 by hand — the same
    scheme lib/r2.ts uses, so the app can presign downloads for whatever this uploads."""

    def __init__(self):
        env = os.environ.get
        self.endpoint = (env('S3_ENDPOINT') or env('R2_S3_ENDPOINT') or '').rstrip('/')
        self.bucket = env('S3_BUCKET') or env('R2_BUCKET') or ''
        self.region = env('S3_REGION') or env('R2_REGION') or 'auto'
        self.access_key = env('S3_ACCESS_KEY_ID') or env('AWS_ACCESS_KEY_ID') or env('R2_ACCESS_KEY_ID') or ''
        self.secret_key = env('S3_SECRET_ACCESS_KEY') or env('AWS_SECRET_ACCESS_KEY') or env('R2_SECRET_ACCESS_KEY') or ''

    def configured(self):
        return all([self.endpoint, self.bucket, self.access_key, self.secret_key])

    def put(self, key, body, content_type):
        host = urllib.parse.urlparse(self.endpoint).netloc
        path = '/' + self.bucket + '/' + '/'.join(urllib.parse.quote(part, safe='') for part in key.split('/'))
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime('%Y%m%dT%H%M%SZ')
        stamp = now.strftime('%Y%m%d')
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = {
            'content-type': content_type or 'application/octet-stream',
            'host': host,
            'x-amz-content-sha256': payload_hash,
            'x-amz-date': amz_date,
        }
        signed = ';'.join(sorted(headers))
        canonical = '\n'.join(['PUT', path, '', *(f'{k}:{headers[k]}' for k in sorted(headers)), '', signed, payload_hash])
        scope = f'{stamp}/{self.region}/s3/aws4_request'
        to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        key_bytes = ('AWS4' + self.secret_key).encode()
        for part in (stamp, self.region, 's3', 'aws4_request'):
            key_bytes = hmac.new(key_bytes, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key_bytes, to_sign.encode(), hashlib.sha256).hexdigest()
        headers['authorization'] = (f'AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, '
                                    f'SignedHeaders={signed}, Signature={signature}')
        del headers['host']
        request = urllib.request.Request(self.endpoint + path, data=body, headers=headers, method='PUT')
        with urllib.request.urlopen(request, timeout=120):
            return key


S3 = S3Store()


def upload_object(message_id, attachment):
    """Store to the S3-API bucket and return the object key the app will presign."""
    safe = re.sub(r'[^\w.\- ]+', '_', attachment['filename'] or 'attachment')[:120]
    key = f'mail/{message_id}/{secrets.token_hex(6)}-{safe}'
    return S3.put(key, attachment['bytes'], attachment.get('contentType'))


def upload_blob(token, message_id, attachment):
    safe = re.sub(r'[^\w.\- ]+', '_', attachment['filename'] or 'attachment')
    request = urllib.request.Request(
        f'https://blob.vercel-storage.com/mail/{message_id}/{urllib.parse.quote(safe)}',
        data=attachment['bytes'],
        headers={'authorization': f'Bearer {token}',
                 'x-content-type': attachment.get('contentType') or 'application/octet-stream',
                 'x-add-random-suffix': '1', 'x-api-version': '7'},
        method='PUT',
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)['url']


def store_attachment(token, message_id, attachment):
    """Upload one attachment; returns the fields to merge into its stored entry."""
    UPLOAD_BUDGET.reserve(attachment['size'])
    if STORE == 's3':
        key = with_retry(lambda: upload_object(message_id, attachment), attachment['filename'][:30])
        return {'key': key}
    link = with_retry(lambda: upload_blob(token, message_id, attachment), attachment['filename'][:30])
    return {'url': link}


STORE = 'blob'


def stored_attachments(url, token, ids):
    """id -> (owner, attachments, table) for rows already stored, in either table."""
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    results = execute(url, token, [
        {'sql': f'SELECT id, owner, attachments FROM mail_inbox WHERE id IN ({marks})', 'args': [arg(i) for i in ids]},
        {'sql': f'SELECT s.id, m.owner, s.attachments FROM mail_sent s LEFT JOIN mail_sent_meta m ON m.email_id = s.id '
                f'WHERE s.id IN ({marks})', 'args': [arg(i) for i in ids]},
    ])
    found = {}
    for table, result in zip(('mail_inbox', 'mail_sent'), results[:2]):
        for row in result['response']['result']['rows']:
            try:
                entries = json.loads(row[2]['value'] or '[]')
            except Exception:
                entries = []
            found[row[0]['value']] = ((row[1]['value'] or '').lower(), entries, table)
    return found


def arg(value, kind='text'):
    if value is None:
        return {'type': 'null', 'value': None}
    return {'type': kind, 'value': str(value)}


def execute(url, token, statements):
    if url.startswith('file:'):
        return execute_sqlite(url[len('file:'):], statements)
    return with_retry(lambda: execute_once(url, token, statements), 'turso')


SQLITE_LOCK = threading.Lock()


def execute_sqlite(path, statements):
    """The pipeline's shape over a local SQLite file, for a database that is not served over HTTP."""
    with SQLITE_LOCK, sqlite3.connect(path, timeout=120) as connection:
        connection.execute('PRAGMA busy_timeout = 120000')
        results = []
        for statement in statements:
            cursor = connection.execute(statement['sql'], [a['value'] for a in statement['args']])
            rows = cursor.fetchall() if cursor.description else []
            results.append({'response': {'result': {'rows': [[{'value': cell} for cell in row] for row in rows]}}})
        return results


def execute_once(url, token, statements):
    requests = [{'type': 'execute', 'stmt': stmt} for stmt in statements] + [{'type': 'close'}]
    request = urllib.request.Request(
        url.replace('libsql:', 'https:').rstrip('/') + '/v2/pipeline',
        data=json.dumps({'requests': requests}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, method='POST',
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    results = payload.get('results', [])
    for index, result in enumerate(results):
        if result.get('type') == 'error' or 'response' not in result:
            raise RuntimeError(f'statement {index} failed: {json.dumps(result)[:400]}')
    return results


def existing_owners(url, token, ids):
    """id -> owner for rows already stored, in either table."""
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    results = execute(url, token, [
        {'sql': f'SELECT id, owner FROM mail_inbox WHERE id IN ({marks})', 'args': [arg(i) for i in ids]},
        {'sql': f'SELECT s.id, m.owner FROM mail_sent s LEFT JOIN mail_sent_meta m ON m.email_id = s.id '
                f'WHERE s.id IN ({marks})', 'args': [arg(i) for i in ids]},
    ])
    found = {}
    for result in results[:2]:
        for row in result['response']['result']['rows']:
            found[row[0]['value']] = (row[1]['value'] or '').lower()
    return found


def inbox_statement(row):
    return {'sql': INSERT_INBOX, 'args': [
        arg(row['id']), arg(row['from']), arg(json.dumps(row['to'])), arg(json.dumps(row['cc'])),
        arg(json.dumps(row['bcc'])), arg(json.dumps(row['replyTo'])), arg(row['subject']),
        arg(row['html']), arg(row['text']), arg(json.dumps(row['headers'])), arg(row['receivedAt']),
        arg(1 if row['read'] else 0, 'integer'), arg(json.dumps(row['attachments'])), arg(row['owner']),
        arg(1 if row['starred'] else 0, 'integer'), arg(1 if row['archived'] else 0, 'integer'),
        arg(1 if row['trashed'] else 0, 'integer'), arg(json.dumps(row['labels'])),
    ]}


def sent_statements(row):
    return [
        {'sql': INSERT_SENT, 'args': [
            arg(row['id']), arg(row['from']), arg(json.dumps(row['to'])), arg(json.dumps(row['cc'])),
            arg(json.dumps(row['bcc'])), arg(json.dumps(row['replyTo'])), arg(row['subject']),
            arg(row['html']), arg(row['text']), arg(row['receivedAt']), arg('imported'), arg('mbox'),
            arg(json.dumps(row['attachments'])),
        ]},
        {'sql': INSERT_SENT_META, 'args': [arg(row['id']), arg(row['owner']), arg(row['receivedAt'])]},
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mbox')
    parser.add_argument('--owner', required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--limit', type=int, help='stop after this many messages')
    parser.add_argument('--start', type=int, default=0, help='skip this many messages first (resume)')
    parser.add_argument('--batch', type=int, default=10)
    parser.add_argument('--mark-read', action='store_true')
    parser.add_argument('--skip-attachments', action='store_true')
    parser.add_argument('--kinds', default='inbox,sent', help='which rows the attachment pass touches: inbox, sent, or both')
    parser.add_argument('--attach-only', action='store_true',
                        help='second pass: upload attachments for rows already imported and write the URLs back')
    parser.add_argument('--workers', type=int, default=8, help='parallel attachment uploads')
    parser.add_argument('--writers', type=int, default=6, help='database batches in flight at once')
    parser.add_argument('--max-mbps', type=float, help='cap aggregate upload bandwidth, e.g. 4.5')
    parser.add_argument('--chunks', type=int, default=4, help='attachment chunks in flight at once')
    parser.add_argument('--replace-blob', action='store_true',
                        help='treat entries hosted on Vercel Blob as missing so they are re-uploaded to the bucket')
    parser.add_argument('--store', choices=['blob', 's3'], default='s3' if S3.configured() else 'blob',
                        help='where attachment bytes go: Vercel Blob, or an S3-API bucket (R2/S3)')
    args = parser.parse_args()
    if args.attach_only and args.batch == 10:
        args.batch = 5

    global STORE
    STORE = args.store
    owner = args.owner.lower()
    if STORE == 's3' and not S3.configured() and not args.dry_run and not args.skip_attachments:
        sys.exit('--store s3 needs S3_/R2_ endpoint, bucket and keys in the environment')
    if STORE == 's3':
        print(f'attachment store: s3 bucket {S3.bucket} at {S3.endpoint} (region {S3.region})', flush=True)
    if args.max_mbps:
        UPLOAD_BUDGET.__init__(args.max_mbps)
        print(f'upload cap: {args.max_mbps} Mbit/s', flush=True)
    url, db_token = (os.environ.get('DATABASE_URL') or os.environ.get('TURSO_DATABASE_URL')), (os.environ.get('DATABASE_AUTH_TOKEN') or os.environ.get('TURSO_AUTH_TOKEN'))
    blob_token = None if args.skip_attachments else (os.environ.get('BLOB_READ_WRITE_TOKEN') if STORE == 'blob' else 's3')
    if not args.dry_run and not (url and (db_token or url.startswith('file:'))):
        sys.exit('DATABASE_URL and DATABASE_AUTH_TOKEN must be set')
    kinds = {kind.strip() for kind in args.kinds.split(',') if kind.strip()}
    if not args.dry_run and not args.skip_attachments and not blob_token:
        print('BLOB_READ_WRITE_TOKEN unset: attachments will be metadata only', flush=True)

    stats = {'seen': 0, 'inbox': 0, 'sent': 0, 'skipped': 0, 'existing': 0, 'undated': 0, 'missing': 0,
            'updated': 0, 'files': 0, 'file_bytes': 0, 'files_skipped': 0, 'file_errors': 0}
    chunk = []
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) if args.attach_only else None

    def process_attach_chunk(rows):
        local = {'updated': 0, 'existing': 0, 'missing': 0, 'files': 0, 'file_bytes': 0,
                 'files_skipped': 0, 'file_errors': 0}
        if args.dry_run:
            for row in rows:
                local['files'] += len(row['attachments'])
                local['file_bytes'] += sum(a['size'] for a in row['attachments'])
            return local
        stored = stored_attachments(url, db_token, [i for row in rows for i in (row['primary_id'], row['alt_id'])])
        jobs = []
        for row in rows:
            mine = next((i for i in (row['primary_id'], row['alt_id'])
                         if i in stored and stored[i][0] == row['owner']), None)
            if mine is None:
                local['missing'] += 1
                continue
            row['id'] = mine
            row['table'] = stored[mine][2]
            entries = stored[mine][1]
            want = len(row['attachments'])
            complete = lambda e: bool(e.get('key')) or (bool(e.get('url')) and not args.replace_blob)
            # Completeness is tested before reuse. The other order rewrote every shared copy
            # whose primary was keyed on every pass — even ones already finished — so a
            # mailbox of shared copies burned whole slices without ever reaching what was
            # actually missing. Compare >= and slice: a stored row can hold more entries
            # than the message parses out, and such a row yields no work either way.
            if len(entries) >= want and all(complete(e) for e in entries[:want]):
                local['existing'] += 1
                continue
            if mine == row['alt_id'] and row['primary_id'] in stored:
                primary_entries = stored[row['primary_id']][1]
                if len(primary_entries) >= want and all(e.get('key') for e in primary_entries[:want]):
                    row['stored'] = [dict(e) for e in primary_entries[:want]]
                    row['reuse'] = True
                    local['reused'] = local.get('reused', 0) + 1
                    continue
            row['stored'] = entries
            for index, attachment in enumerate(row['attachments']):
                if index < len(entries) and complete(entries[index]):
                    continue
                if attachment['size'] > BLOB_LIMIT_BYTES:
                    local['files_skipped'] += 1
                    continue
                jobs.append((row, index, attachment))
        futures = {pool.submit(store_attachment, blob_token, row['id'], attachment): (row, index, attachment)
                   for row, index, attachment in jobs}
        touched = set()
        for future in concurrent.futures.as_completed(futures):
            row, index, attachment = futures[future]
            try:
                stored_fields = future.result()
            except Exception as err:
                local['file_errors'] += 1
                print(f'  ! {attachment["filename"]}: {str(err)[:100]}', flush=True)
                continue
            entries = row['stored']
            while len(entries) <= index:
                entries.append({})
            entries[index] = {'filename': attachment['filename'], 'contentType': attachment['contentType'],
                              'size': attachment['size'], **stored_fields}
            local['files'] += 1
            local['file_bytes'] += attachment['size']
            touched.add(row['id'])
        for row in rows:
            if row['id'] in touched or row.get('reuse'):
                execute(url, db_token, [{'sql': f'UPDATE {row["table"]} SET attachments = ? WHERE id = ?',
                                         'args': [arg(json.dumps(row['stored'])), arg(row['id'])]}])
                local['updated'] += 1
            for attachment in row['attachments']:
                attachment.pop('bytes', None)
        return local

    chunk_pool = concurrent.futures.ThreadPoolExecutor(max_workers=args.chunks) if args.attach_only else None
    attach_in_flight = []

    def collect_attach(done_only=True):
        remaining = []
        for future in attach_in_flight:
            if done_only and not future.done():
                remaining.append(future)
                continue
            try:
                counters = future.result()
            except Exception as err:
                stats['batch_errors'] = stats.get('batch_errors', 0) + 1
                print(f'  ! chunk lost: {str(err)[:140]}', flush=True)
                continue
            for key, value in counters.items():
                stats[key] = stats.get(key, 0) + value
        attach_in_flight[:] = remaining

    def flush_attach():
        if not chunk:
            return
        rows = chunk[:]
        chunk.clear()
        while len(attach_in_flight) >= args.chunks * 2:
            concurrent.futures.wait(attach_in_flight, return_when=concurrent.futures.FIRST_COMPLETED)
            collect_attach()
        attach_in_flight.append(chunk_pool.submit(process_attach_chunk, rows))
        collect_attach()

    def write_rows(rows):
        local = {'inbox': 0, 'sent': 0, 'existing': 0, 'files': 0, 'file_bytes': 0,
                 'files_skipped': 0, 'file_errors': 0, 'row_errors': 0}
        if args.dry_run:
            for row in rows:
                local[row['kind']] += 1
                local['files'] += len(row['attachments'])
                local['file_bytes'] += sum(a['size'] for a in row['attachments'])
            return local
        owners = existing_owners(url, db_token, [i for row in rows for i in (row['primary_id'], row['alt_id'])])
        statements = []
        for row in rows:
            if row['alt_id'] in owners or owners.get(row['primary_id']) == row['owner']:
                local['existing'] += 1
                continue
            if row['primary_id'] in owners:
                row['id'] = row['alt_id']
                row['headers']['shared-copy-of'] = row['primary_id']
                local['shared'] = local.get('shared', 0) + 1
            for attachment in row['attachments']:
                if blob_token and attachment['size'] <= BLOB_LIMIT_BYTES:
                    try:
                        attachment.update(store_attachment(blob_token, row['id'], attachment))
                        local['files'] += 1
                        local['file_bytes'] += attachment['size']
                    except Exception as err:
                        local['file_errors'] += 1
                        print(f'  ! {attachment["filename"]}: {err}', flush=True)
                elif blob_token:
                    local['files_skipped'] += 1
                attachment.pop('bytes', None)
            if row['kind'] == 'sent':
                statements += sent_statements(row)
            else:
                statements.append(inbox_statement(row))
            local[row['kind']] += 1
        if not statements:
            return local
        try:
            execute(url, db_token, statements)
        except Exception as err:
            print(f'  batch failed ({str(err)[:120]}); retrying rows one at a time', flush=True)
            for statement in statements:
                try:
                    execute(url, db_token, [statement])
                except Exception as inner:
                    local['row_errors'] += 1
                    print(f'  ! row failed: {str(inner)[:160]}', flush=True)
        return local

    writers = concurrent.futures.ThreadPoolExecutor(max_workers=args.writers)
    in_flight = []

    def collect(done_only=True):
        remaining = []
        for future in in_flight:
            if done_only and not future.done():
                remaining.append(future)
                continue
            try:
                counters = future.result()
            except Exception as err:
                stats['batch_errors'] = stats.get('batch_errors', 0) + 1
                print(f'  ! batch lost: {str(err)[:140]}', flush=True)
                continue
            for key, value in counters.items():
                stats[key] = stats.get(key, 0) + value
        in_flight[:] = remaining

    def flush():
        if not chunk:
            return
        rows = chunk[:]
        chunk.clear()
        while len(in_flight) >= args.writers * 2:
            concurrent.futures.wait(in_flight, return_when=concurrent.futures.FIRST_COMPLETED)
            collect()
        in_flight.append(writers.submit(write_rows, rows))
        collect()

    for index, raw in enumerate(messages(args.mbox)):
        if index < args.start:
            continue
        if args.limit and stats['seen'] >= args.limit:
            break
        stats['seen'] += 1
        row = row_for(email.message_from_bytes(raw), owner, args.mark_read, keep_bytes=not args.skip_attachments)
        if row['kind'] == 'skip':
            stats['skipped'] += 1
            continue
        if not row['receivedAt']:
            stats['undated'] += 1
            continue
        if stats['seen'] <= 12:
            flag = 'read ' if row['read'] else 'UNRD '
            print(f'  {row["receivedAt"][:10]} {row["kind"]:5} {flag} {row["from"][:30]:30} {row["subject"][:44]}'
                  f'  [{len(row["attachments"])} files]', flush=True)
        if args.attach_only:
            if row['kind'] not in kinds or not row['attachments']:
                continue
            chunk.append(row)
            if len(chunk) >= args.batch:
                flush_attach()
            if stats['seen'] % 500 == 0:
                print(f'... {stats["seen"]} seen, {stats["updated"]} rows updated, {stats["existing"]} already done, '
                      f'{stats.get("reused", 0)} reused, {stats.get("missing", 0)} missing, '
                      f'{stats["files"]} files ({stats["file_bytes"]/1e9:.2f} GB), {stats["file_errors"]} errors', flush=True)
            continue
        chunk.append(row)
        if len(chunk) >= args.batch:
            flush()
        if stats['seen'] % 500 == 0:
            print(f'... {stats["seen"]} seen, {stats["inbox"]} inbox, {stats["sent"]} sent, '
                  f'{stats["existing"]} existing, {stats["files"]} files ({stats["file_bytes"]/1e9:.2f} GB)', flush=True)
    if args.attach_only:
        flush_attach()
        concurrent.futures.wait(attach_in_flight)
        collect_attach(done_only=False)
        chunk_pool.shutdown(wait=True)
        pool.shutdown(wait=True)
    else:
        flush()
        concurrent.futures.wait(in_flight)
        collect(done_only=False)
        writers.shutdown(wait=True)

    mode = 'dry run — nothing written' if args.dry_run else ('attachments backfilled' if args.attach_only else 'imported')
    print(f'\n{mode} for {owner}')
    if args.attach_only:
        print(f'  seen {stats["seen"]}  rows updated {stats["updated"]}  already complete {stats["existing"]}  '
              f'not in db {stats["missing"]}  keys reused from shared copy {stats.get("reused", 0)}')
    else:
        print(f'  seen {stats["seen"]}  inbox {stats["inbox"]}  sent {stats["sent"]}  spam/drafts skipped {stats["skipped"]}'
          f'  already present {stats["existing"]}  shared copies {stats.get("shared", 0)}  undated {stats["undated"]}')
    print(f'  attachments {stats["files"]} ({stats["file_bytes"]/1e9:.2f} GB)'
          f'  over 20MB skipped {stats["files_skipped"]}  upload errors {stats["file_errors"]}  row errors {stats.get("row_errors", 0)}  batches lost {stats.get("batch_errors", 0)}')


if __name__ == '__main__':
    main()
