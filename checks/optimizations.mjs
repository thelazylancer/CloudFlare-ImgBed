import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { getDatabase, retentionIndexKey, RETENTION_INDEX_PREFIX } from '../functions/utils/databaseAdapter.js';
import { cleanupExpiredFiles, getCleanupStatus } from '../functions/utils/retentionCleanup.js';
import { readIndex } from '../functions/utils/indexManager.js';
import { errorHandling, telemetryData, sanitizeTelemetryEvent } from '../functions/utils/middleware.js';
import { getOthersConfig } from '../functions/api/manage/sysConfig/others.js';
import { onRequest as upload } from '../functions/upload/index.js';
import { onRequest as list } from '../functions/api/manage/list.js';
import { onRequestGet as cleanupStatus } from '../functions/api/manage/cleanupExpired.js';
import { runCleanup } from '../deploy/cleanup/index.js';

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("check"); } }',
    compatibilityDate: '2024-08-21', kvNamespaces: ['img_url'], d1Databases: ['img_d1'] });
const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout;
let sends = 0, rollbacks = 0, missingPaths = 0, rollbackFailure = false;
globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/sendDocument')) {
        sends++;
        return Response.json({ ok: true, result: { message_id: sends, chat: { id: -10001 }, date: Math.floor(Date.now() / 1000),
            document: { file_id: 'file', file_unique_id: 'unique', file_size: 4 } } });
    }
    if (url.includes('/getFile?')) return Response.json(missingPaths-- > 0 ? { ok: false } : { ok: true, result: { file_path: 'doc/file.txt' } });
    if (url.endsWith('/deleteMessage')) {
        rollbacks++;
        return Response.json({ ok: !rollbackFailure }, { status: rollbackFailure ? 500 : 200 });
    }
    throw new Error(`Unexpected storage request: ${new URL(url).hostname}`);
};
const storageFetch = globalThis.fetch;
const auth = { Authorization: 'Bearer admin-token' };
const config = { auth: { admin: { adminUsername: 'admin', adminPassword: 'local-check' } }, apiTokens: { tokens: {
    admin: { token: 'admin-token', permissions: ['upload', 'manage'] }, uploader: { token: 'upload-token', permissions: ['upload'] },
} } };
const form = fields => { const body = new FormData(); for (const [key, value] of Object.entries(fields)) body.set(key, value); return body; };
const uploadBody = () => form({ file: new File(['test'], 'sample.txt', { type: 'text/plain' }) });
async function request(handler, env, path, options = {}) {
    const tasks = [];
    const req = new Request('https://img.test' + path, options);
    const context = { env, request: req, data: {}, waitUntil: task => tasks.push(task) };
    const response = await handler(context);
    await Promise.all(tasks);
    return response;
}
function failingBinding(binding, kind) {
    return new Proxy(binding, { get(target, property) {
        if (kind === 'KV' && property === 'put') return (key, ...args) => {
            if (!key.startsWith('manage@')) throw new Error('simulated metadata write failure');
            return target.put(key, ...args);
        };
        if (kind === 'D1' && property === 'prepare') return sql => {
            if (sql.startsWith('INSERT OR REPLACE INTO files')) return { bind: () => ({ run: async () => { throw new Error('simulated metadata write failure'); } }) };
            return target.prepare(sql);
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
try {
    const kv = await mf.getKVNamespace('img_url'), d1 = await mf.getD1Database('img_d1');
    await d1.exec((await readFile(new URL('../database/init.sql', import.meta.url), 'utf8'))
        .split('\n').filter(line => !line.trim().startsWith('--')).join(' '));
    for (const [kind, binding] of [['KV', kv], ['D1', d1]]) {
        const bindingKey = kind === 'KV' ? 'img_url' : 'img_d1';
        const env = { [bindingKey]: binding, TG_BOT_TOKEN: 'local-bot', TG_CHAT_ID: '-10001' };
        const db = getDatabase(env);
        await db.put('manage@sysConfig@security', JSON.stringify(config));
        const faultEnv = { ...env, [bindingKey]: failingBinding(binding, kind) };
        for (const path of ['/upload', '/upload?initChunked=true', '/upload?chunked=true', '/upload?chunked=true&merge=true']) {
            assert.equal((await request(upload, env, path, { method: 'POST', body: '{invalid', headers: auth })).status, 400);
        }
        for (const body of [form({}), form({ file: 'not a file' })]) {
            assert.equal((await request(upload, env, '/upload', { method: 'POST', body, headers: auth })).status, 400);
        }
        for (const chunkIndex of ['invalid', '-1', '2', '0.5', '']) {
            const body = form({ file: new File(['x'], 'chunk'), chunkIndex, totalChunks: '2', uploadId: 'test', originalFileName: 'x', originalFileType: 'text/plain' });
            const response = await request(upload, env, '/upload?chunked=true', { method: 'POST', body, headers: auth });
            assert.equal(response.status, 400); assert.match(await response.text(), /Missing chunk upload parameters/);
        }
        // A saved Telegram message is withdrawn on persistence failure and automatic retry stops.
        sends = rollbacks = 0; missingPaths = 0;
        assert.equal((await request(upload, faultEnv, '/upload', { method: 'POST', body: uploadBody(), headers: auth })).status, 500);
        assert.equal(sends, 1); assert.equal(rollbacks, 1);
        sends = rollbacks = 0; missingPaths = 1;
        assert.equal((await request(upload, env, '/upload?autoRetry=false', { method: 'POST', body: uploadBody(), headers: auth })).status, 502);
        assert.equal(sends, 1); assert.equal(rollbacks, 1);
        // Persistence failure in the retry itself must also stop before another channel.
        sends = rollbacks = 0; missingPaths = 1;
        assert.equal((await request(upload, faultEnv, '/upload', { method: 'POST', body: uploadBody(), headers: auth })).status, 500);
        assert.equal(sends, 2); assert.equal(rollbacks, 2);
        sends = rollbacks = 0; missingPaths = 1; rollbackFailure = true;
        assert.equal((await request(upload, env, '/upload', { method: 'POST', body: uploadBody(), headers: auth })).status, 502);
        assert.equal(sends, 1); assert.equal(rollbacks, 1);
        rollbackFailure = false; missingPaths = 0;

        assert.equal((await getOthersConfig(db, env)).telemetry.enabled, false);
        let calls = 0;
        const context = { env, data: {}, request: new Request('https://img.test/upload'), next: async () => { calls++; return new Response('ok'); } };
        await errorHandling(context); assert.equal(context.data.telemetry, false); assert.equal(calls, 1);
        await db.put('manage@sysConfig@others', JSON.stringify({ telemetry: { enabled: true } }));
        calls = 0; await errorHandling(context); assert.equal(context.data.telemetry, false); assert.equal(calls, 1, 'no DSN must keep telemetry disabled');
        const downstream = new Error('downstream failure');
        const instrumented = { data: { telemetry: true, sentry: { setTag: () => { throw new Error('instrumentation failure'); } } },
            request: context.request, next: async () => { calls++; throw downstream; } };
        calls = 0; await assert.rejects(telemetryData(instrumented), error => error === downstream); assert.equal(calls, 1);

        const now = Date.now(), expired = now - 10000;
        for (let i = 0; i < 100; i++) await db.put(`permanent-${i}`, '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: null } });
        if (kind === 'KV') {
            await kv.put('legacy-expired', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: expired } });
        } else await db.put('legacy-expired', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: expired } });
        await db.put('renewed', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: expired } });
        await db.put('renewed', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: now + 86400000 } });
        await db.put('made-permanent', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: expired } });
        await db.put('made-permanent', '', { metadata: { TimeStamp: now, Channel: 'External', ExpiresAt: null } });
        let rounds = 0, stats;
        do { stats = await cleanupExpiredFiles(env); assert.ok(++rounds < 100); } while (stats.hasMore);
        assert.equal((await db.getWithMetadata('legacy-expired'))?.metadata ?? null, null);
        for (const id of ['renewed', 'made-permanent', 'permanent-0']) assert.ok((await db.getWithMetadata(id)).metadata);
        const indexReads = [];
        const observedEnv = kind === 'KV' ? { ...env, img_url: new Proxy(kv, { get(target, property) {
            if (property === 'list') return options => { indexReads.push(options); return target.list(options); };
            const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } }) } : env;
        await cleanupExpiredFiles(observedEnv);
        if (kind === 'KV') assert.ok(indexReads.every(options => options.prefix === RETENTION_INDEX_PREFIX), 'after backfill, cleanup must only scan expiry markers');
        if (kind === 'D1') {
            const plan = await d1.prepare("EXPLAIN QUERY PLAN SELECT id FROM files WHERE json_type(metadata, '$.ExpiresAt') IN ('integer', 'real') AND json_extract(metadata, '$.ExpiresAt') <= ? ORDER BY json_extract(metadata, '$.ExpiresAt'), id LIMIT 4").bind(now).all();
            assert.ok(plan.results.some(row => row.detail.includes('idx_files_expires_at')));
            assert.equal((await cleanupExpiredFiles({ ...env, img_url: kv })).scanned, 0, 'D1 must take priority when both bindings exist');
        }
        for (let i = 0; i < 7; i++) await db.put(`batch-expired-${i}`, '', { metadata: { Channel: 'External', ExpiresAt: expired - i } });
        rounds = 0;
        do { stats = await cleanupExpiredFiles(env); assert.ok(++rounds < 10); } while (stats.hasMore);
        for (let i = 0; i < 7; i++) assert.equal((await db.getWithMetadata(`batch-expired-${i}`))?.metadata ?? null, null);
        let failDelete = true;
        const failedEnv = { ...env, img_r2: { delete: async () => { if (failDelete) throw new Error('simulated deletion failure'); } } };
        await db.put('failed-delete', '', { metadata: { Channel: 'CloudflareR2', ExpiresAt: expired } });
        assert.equal((await cleanupExpiredFiles(failedEnv)).failed, 1);
        assert.ok((await getCleanupStatus(env)).recentFailures.some(item => item.fileId === 'failed-delete'));
        failDelete = false;
        assert.equal((await cleanupExpiredFiles(failedEnv)).deleted, 1);
        const status = await getCleanupStatus(env);
        assert.ok(status.lastRunAt && status.lastCompletedAt && status.totalDeleted >= 2);
        assert.equal(status.recentFailures.length, 0); assert.equal(status.cursor, undefined);
        assert.equal((await request(cleanupStatus, env, '/api/manage/cleanupExpired')).status, 401);
        assert.equal((await request(cleanupStatus, env, '/api/manage/cleanupExpired', { headers: { Authorization: 'Bearer upload-token' } })).status, 401);
        const statusResponse = await request(cleanupStatus, env, '/api/manage/cleanupExpired', { headers: auth });
        assert.equal(statusResponse.status, 200); assert.match(statusResponse.headers.get('Cache-Control'), /no-store/);

        // Real index chunks, mixed deadlines, folders and filters; retain pagination order across chunks.
        const files = [
            ['a/first.txt', now + 86400000, 'text/plain', 'a/'], ['a/sub/expired.jpg', expired, 'image/jpeg', 'a/sub/'],
            ['a/permanent.jpg', null, 'image/jpeg', 'a/'], ['a/sub/nested.jpg', now + 86400000, 'image/jpeg', 'a/sub/'],
            ['else/image.jpg', now + 86400000, 'image/jpeg', 'else/'], ['a/blocked.jpg', now + 86400000, 'image/jpeg', 'a/'],
            ['a/legacy.txt', undefined, 'text/plain', 'a/'], ['a/other.bin', expired, 'application/octet-stream', 'a/'],
        ].map(([id, ExpiresAt, FileType, Directory], i) => ({ id, metadata: { ExpiresAt, FileType, Directory, TimeStamp: now - i,
            Channel: id.includes('nested') ? 'CloudflareR2' : 'External', ChannelName: 'default',
            Tags: id.includes('nested') ? ['feature'] : [], Label: id.includes('blocked') ? 'adult' : 'everyone' } }));
        for (const file of files) await db.put(file.id, '', { metadata: file.metadata });
        const ops = await db.list({ prefix: 'manage@index@operation_', limit: 1000 });
        for (const op of ops.keys) await db.delete(op.name);
        await db.put('manage@index@meta', JSON.stringify({ chunkCount: 3, totalCount: files.length, lastUpdated: now, lastOperationId: null }));
        for (let i = 0; i < 3; i++) await db.put(`manage@index_${i}`, JSON.stringify(files.slice(i * 3, i * 3 + 3)));
        const reads = new Map();
        const indexEnv = kind === 'KV' ? { ...env, img_url: new Proxy(kv, { get(target, property) {
            if (property === 'get') return (key, ...args) => { reads.set(key, (reads.get(key) || 0) + 1); return target.get(key, ...args); };
            const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } }) } : env;
        let result = await request(context => readIndex(context, { directory: 'a', start: 1, count: 2 }), indexEnv, '/api/manage/list');
        assert.deepEqual(result.files.map(file => file.id), ['a/permanent.jpg', 'a/blocked.jpg']);
        assert.equal(result.totalCount, 5); assert.equal(result.directFileCount, 4); assert.deepEqual(result.directories, ['a/sub']);
        if (kind === 'KV') for (let i = 0; i < 3; i++) assert.equal(reads.get(`manage@index_${i}`), 1, 'normal list reads must not load chunks twice');
        for (const [retention, expected] of [['temporary', 3], ['permanent', 2], ['expired', 2]]) {
            const response = await request(list, env, `/api/manage/list?dir=a&retention=${retention}&recursive=true&count=-1`);
            assert.equal((await response.json()).files.length, expected, retention);
        }
        const filtered = await (await request(list, env, '/api/manage/list?dir=a&includeTags=feature&channelName=CloudflareR2:default&fileType=image&accessStatus=normal')).json();
        assert.equal(filtered.directories.length, 1); assert.equal(filtered.totalCount, 1);
        assert.equal((await (await request(list, env, '/api/manage/list?dir=a&retention=permanent&count=-1&sum=true')).json()).sum, 2);
        await db.put('manage@index@operation_pending', JSON.stringify({ type: 'remove', timestamp: now,
            data: { fileId: 'a/blocked.jpg' } }));
        reads.clear();
        const merged = await request(context => readIndex(context, { directory: 'a', count: -1 }), indexEnv, '/api/manage/list');
        assert.ok(!merged.files.some(file => file.id === 'a/blocked.jpg'));
        if (kind === 'KV') for (let i = 0; i < 3; i++) assert.equal(reads.get(`manage@index_${i}`), 1, 'merged list must reuse already loaded chunks');
        assert.equal((await request(list, env, '/api/manage/list?retention=invalid')).status, 400);
        await db.delete('manage@index_0');
        const fallback = await (await request(list, env, '/api/manage/list?dir=a&retention=expired&recursive=true&count=1')).json();
        assert.equal(fallback.isIndexedResponse, false); assert.equal(fallback.files.length, 1); assert.equal(fallback.totalCount, 2);
        console.log(`${kind}: upload compensation, telemetry, expiry index, cleanup status and chunk pagination passed`);
    }
    const sanitized = sanitizeTelemetryEvent({
        request: { url: 'https://user:pass@img.test/upload?token=query-secret&authCode=code-secret', method: 'POST',
            headers: { authorization: 'Bearer bearer-secret', cookie: 'admin_session=cookie-secret', 'content-type': 'multipart/form-data' }, data: 'body-secret', cookies: { admin: 'cookie-secret' } },
        contexts: { request: { url: 'https://api.telegram.org/botBOT_SECRET/getFile?file_id=FILE_SECRET' }, trace: { trace_id: 'trace', data: { token: 'trace-secret' } } },
        exception: { values: [{ type: 'Error', value: 'Failed https://api.telegram.org/botBOT_SECRET/getFile?token=query-secret Bearer bearer-secret authCode=code-secret',
            stacktrace: { frames: [{ filename: 'https://img.test/script?token=query-secret', vars: { key: 'frame-secret' }, lineno: 12 }] } }] },
        message: 'cookie=cookie-secret', user: { ip_address: '10.0.0.1' }, extra: { env: 'extra-secret' },
        breadcrumbs: [{ data: 'breadcrumb-secret' }], tags: { query: 'query-secret', method: 'POST' },
        spans: [{ op: 'http', description: 'Bearer bearer-secret', data: { url: 'span-secret' } }],
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of ['query-secret', 'code-secret', 'bearer-secret', 'cookie-secret', 'body-secret', 'BOT_SECRET', 'FILE_SECRET', 'trace-secret', 'frame-secret', 'extra-secret', 'breadcrumb-secret', 'span-secret', 'user:pass']) assert.ok(!serialized.includes(secret), secret);
    assert.equal(sanitized.exception.values[0].stacktrace.frames[0].lineno, 12);
    assert.equal(sanitizeTelemetryEvent({ request: { cookies: { token: 'secret' }, data: 'secret' } }).request.data, undefined);
    assert.ok((await retentionIndexKey('x'.repeat(500), Date.now())).length < 512);

    // Bound the external scheduler even with an endless backlog; never include response bodies in errors.
    let batches = 0;
    globalThis.setTimeout = callback => originalSetTimeout(callback, 0);
    globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://img.test/api/manage/cleanupExpired');
        assert.equal(options.headers.Authorization, 'Bearer scheduler-secret');
        return Response.json({ deleted: ++batches <= 2 ? 1 : 0, failed: 0, hasMore: batches < 3 });
    };
    assert.deepEqual(await runCleanup({ IMGBED_URL: 'https://img.test', IMGBED_MANAGE_TOKEN: 'scheduler-secret' }), { batches: 3, deleted: 2, failed: 0, hasMore: false });
    batches = 0;
    globalThis.fetch = async () => { batches++; return Response.json({ deleted: 0, failed: 0, hasMore: true }); };
    assert.equal((await runCleanup({ IMGBED_URL: 'https://img.test', IMGBED_MANAGE_TOKEN: 'scheduler-secret' })).batches, 25);
    assert.equal(batches, 25);
    globalThis.fetch = async () => new Response('scheduler-secret', { status: 401 });
    await assert.rejects(runCleanup({ IMGBED_URL: 'https://img.test', IMGBED_MANAGE_TOKEN: 'scheduler-secret' }), error => error.message === 'Cleanup endpoint returned 401');
    console.log('Optimization checks passed (local KV/D1 and simulated network only).');
} finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout;
    await mf.dispose();
}
