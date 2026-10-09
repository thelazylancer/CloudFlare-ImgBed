import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, normalizeS3UserAgent } from '../functions/utils/storage/s3Client.js';
import { parseRetention, canStorePermanently, isFileExpired } from '../functions/utils/fileRetention.js';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { rebuildIndex, readIndex } from '../functions/utils/indexManager.js';
import { cleanupExpiredFiles, deleteExpiredFile } from '../functions/utils/retentionCleanup.js';
import { onRequest as upload } from '../functions/upload/index.js';
import { onRequest as read } from '../functions/file/[[path]].js';
import { onRequestPost as commit } from '../functions/upload/huggingface/commitUpload.js';
import { onRequestPost as cleanup } from '../functions/api/manage/cleanupExpired.js';
import { onRequestGet as sessionCheck } from '../functions/api/auth/sessionCheck.js';
import { onRequest as publicList } from '../functions/api/public/list.js';
import { onRequest as random } from '../functions/random/index.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';
import worker from '../deploy/worker/index.js';

const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("local check"); } }',
    compatibilityDate: '2024-08-21', kvNamespaces: ['img_url'], d1Databases: ['img_d1'],
});
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
let remoteFailure = false, hfMissing = false, cacheLookups = 0, upstreamReads = 0;
const deletedMessages = [];
const cachedLists = new Map();
globalThis.caches = { default: {
    match: async request => {
        cacheLookups++;
        const url = typeof request === 'string' ? request : request.url;
        return url.includes('/file/') ? new Response('stale cached file') : cachedLists.get(url)?.clone();
    },
    put: async (request, response) => cachedLists.set(typeof request === 'string' ? request : request.url, response.clone()),
} };
// Every outbound storage request is simulated; an unexpected request fails the check.
globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/sendDocument')) return Response.json({ ok: true, result: {
        message_id: 100, chat: { id: -10001 }, date: Math.floor(Date.now() / 1000),
        document: { file_id: 'tg-file', file_unique_id: 'unique', file_size: 4 },
    } });
    if (url.includes('/getFile?')) return Response.json({ ok: true, result: { file_path: 'doc/file.txt' } });
    if (url.endsWith('/deleteMessage')) {
        deletedMessages.push(JSON.parse(options.body));
        return Response.json(remoteFailure ? { ok: false, error_code: 429 } : { ok: true }, { status: remoteFailure ? 429 : 200 });
    }
    if (url.includes('discord.com/') && options.method === 'DELETE') return new Response(null, { status: remoteFailure ? 403 : 404 });
    if (url.includes('huggingface.co/') && options.method === 'POST') return Response.json({}, { status: remoteFailure ? 400 : 200 });
    if (url.includes('huggingface.co/') && options.method === 'HEAD') return new Response(null, {
        status: 404, headers: { 'X-Error-Code': hfMissing ? 'EntryNotFound' : 'RepoNotFound' },
    });
    throw new Error(`Unexpected network request: ${new URL(url).hostname}`);
};

function r2Storage() {
    const objects = new Map();
    return {
        put: async (key, file) => objects.set(key, new Uint8Array(await file.arrayBuffer())),
        delete: async key => { if (remoteFailure) throw new Error('simulated R2 failure'); objects.delete(key); },
        get: async (key, options = {}) => {
            upstreamReads++;
            const bytes = objects.get(key);
            if (!bytes) return null;
            const offset = options.range?.offset || 0;
            const length = options.range?.length || bytes.length - offset;
            return { body: bytes.slice(offset, offset + length), size: bytes.length,
                ...(options.range ? { range: { offset, length } } : {}),
                writeHttpMetadata: headers => headers.set('Content-Length', String(bytes.length)),
            };
        },
    };
}

function form(fields = {}) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
}
async function run(handler, env, path, { method = 'POST', headers = {}, body, fileId } = {}) {
    const tasks = [];
    const request = new Request(`https://img.test${path}`, { method, headers, body });
    const context = { env, request, url: new URL(request.url), params: { path: fileId },
        waitUntil: promise => tasks.push(promise) };
    const response = await handler(context);
    await Promise.all(tasks);
    return { response, context };
}
const bearer = token => ({ Authorization: `Bearer ${token}` });
const uploadBody = () => form({ file: new File(['test'], 'example.txt', { type: 'text/plain' }) });
const config = { auth: { admin: { adminUsername: 'admin', adminPassword: 'local-check' } },
    access: { imageTransformEnabled: true }, apiTokens: { tokens: {
        uploader: { token: 'upload-only', permissions: ['upload'] },
        admin: { token: 'admin-token', permissions: ['upload', 'manage'] },
        manager: { token: 'manage-only', permissions: ['manage'] },
        expired: { token: 'expired', permissions: ['upload', 'manage'], expiresAt: '2000-01-01T00:00:00Z' },
    } } };

try {
    for (const invalid of ['bad\nagent', '中文', 123]) assert.throws(() => normalizeS3UserAgent(invalid));
    for (const userAgent of ['', '  imgbed-retention-check  ']) {
        const requests = [];
        const client = createS3Client({ endpoint: 'https://s3.test', region: 'auto',
            accessKeyId: 'local-key', secretAccessKey: 'local-secret', pathStyle: true, userAgent }, {
            requestHandler: { handle: async request => {
                requests.push(request);
                return { response: { statusCode: 200, headers: {}, body: new Uint8Array() } };
            } },
        });
        try {
            await client.send(new PutObjectCommand({ Bucket: 'retention', Key: 'example.txt', Body: 'test' }));
            await client.send(new DeleteObjectCommand({ Bucket: 'retention', Key: 'example.txt' }));
            assert.deepEqual(requests.map(request => request.method), ['PUT', 'DELETE']);
            for (const request of requests) {
                assert.equal(request.path, '/retention/example.txt');
                if (userAgent) assert.equal(request.headers['user-agent'], userAgent.trim());
                else assert.match(request.headers['user-agent'], /aws-sdk-js/);
            }
        } finally { client.destroy(); }
    }

    assert.equal(parseRetention(new URLSearchParams()), 86400);
    assert.equal(parseRetention(new URLSearchParams('expiresIn=604800')), 604800);
    assert.equal(parseRetention(new URLSearchParams('permanent=true')), null);
    assert.equal(parseRetention(new URLSearchParams('permanent=false')), 86400);
    for (const query of ['expiresIn=0', 'expiresIn=-1', 'expiresIn=604801', 'expiresIn=1.5', 'expiresIn=01',
        'expiresIn=1e3', 'expiresIn=', 'expiresIn=1&expiresIn=2', 'permanent=1',
        'permanent=true&expiresIn=1', 'permanent=true&permanent=false']) {
        assert.throws(() => parseRetention(new URLSearchParams(query)), error => error.status === 400, query);
    }
    assert.equal(isFileExpired({}), false);
    assert.equal(isFileExpired({ ExpiresAt: null }), false);
    assert.equal(isFileExpired({ ExpiresAt: 1000 }, 1000), true);

    const kv = await mf.getKVNamespace('img_url');
    const d1 = await mf.getD1Database('img_d1');
    await d1.exec((await readFile(new URL('../database/init.sql', import.meta.url), 'utf8'))
        .split('\n').filter(line => !line.trim().startsWith('--')).join(' '));

    for (const [name, binding] of [['KV', { img_url: kv }], ['D1', { img_d1: d1 }]]) {
        cachedLists.clear();
        const env = { ...binding, img_r2: r2Storage(), TG_BOT_TOKEN: 'local-bot', TG_CHAT_ID: '-10001' };
        const db = getDatabase(env);
        await db.put('manage@sysConfig@security', JSON.stringify(config));
        await db.put('manage@sysConfig@upload', JSON.stringify({ huggingface: { channels: [
            { name: 'hf', token: 'local-token', repo: 'local/check', enabled: true },
        ] } }));
        await db.put('manage@session@admin', JSON.stringify({ authType: 'admin', expiresAt: Date.now() + 60000 }));
        for (const token of ['upload-only', 'manage-only', 'expired', 'invalid']) {
            assert.equal(await canStorePermanently(env, new Request('https://img.test', { headers: bearer(token) })), false, token);
        }
        assert.equal(await canStorePermanently(env, new Request('https://img.test', { headers: bearer('admin-token') })), true);
        const adminHeaders = { Cookie: 'admin_session=admin' };
        assert.equal(await canStorePermanently(env, new Request('https://img.test', { headers: adminHeaders })), true);
        assert.equal(await canStorePermanently(env, new Request('https://img.test', { headers: { ...adminHeaders, ...bearer('invalid') } })), false);
        const policy = (await run(sessionCheck, env, '/api/auth/sessionCheck', { method: 'GET', headers: adminHeaders })).response;
        assert.equal((await policy.json()).canStorePermanently, true);
        assert.match(policy.headers.get('Cache-Control'), /no-store/);

        let result = await run(upload, env, '/upload?permanent=true', { headers: bearer('upload-only'), body: uploadBody() });
        assert.equal(result.response.status, 403);
        result = await run(upload, env, '/upload?expiresIn=604801', { body: uploadBody() });
        assert.equal(result.response.status, 400);
        result = await run(upload, env, '/upload', { body: uploadBody() });
        assert.equal(result.response.status, 200);
        const telegram = (await result.response.json())[0];
        const telegramId = telegram.src.slice('/file/'.length);
        let stored = await db.getWithMetadata(telegramId);
        assert.equal(stored.metadata.Channel, 'TelegramNew');
        assert.equal(stored.metadata.TgMessageId, 100);
        assert.equal(stored.metadata.TgMessageChatId, -10001);
        assert.ok(Math.abs(telegram.expiresAt - Date.now() - 86400000) < 10000);
        assert.equal(stored.metadata.ExpiresAt, telegram.expiresAt);
        result = await run(upload, env, '/upload?uploadChannel=cfr2&expiresIn=604800', { headers: bearer('upload-only'), body: uploadBody() });
        assert.equal(result.response.status, 200);
        const r2 = (await result.response.json())[0];
        const fileId = r2.src.slice('/file/'.length);
        assert.ok(Math.abs(r2.expiresAt - Date.now() - 604800000) < 10000);
        for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-1' } }, { headers: { 'If-None-Match': 'old' } }]) {
            const response = (await run(read, env, r2.src, { method: 'GET', ...options, fileId })).response;
            assert.ok([200, 206].includes(response.status));
            assert.match(response.headers.get('Cache-Control'), /no-store/);
        }
        const staleLookups = cacheLookups;
        const tasks = [];
        const response = await worker.fetch(new Request(`https://img.test${r2.src}`), env, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(response.status, 200);
        assert.equal(cacheLookups, staleLookups, 'file reads must bypass existing outer caches');

        for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-1' } },
            { headers: { 'If-None-Match': 'old' } }, { query: '?w=64&h=64&fallback=original' }]) {
            await db.put(fileId, '', { metadata: { Channel: 'CloudflareR2', FileType: 'image/png', ExpiresAt: Date.now() - 1 } });
            const before = upstreamReads;
            const expiredResponse = (await run(read, env, r2.src + (options.query || ''), { method: 'GET', ...options, fileId })).response;
            assert.equal(expiredResponse.status, 404);
            assert.match(expiredResponse.headers.get('Cache-Control'), /no-store/);
            assert.equal(upstreamReads, before, 'expiry must be checked before storage reads');
        }
        assert.equal((await run(read, env, r2.src, { method: 'GET', fileId })).response.status, 404, 'deleted KV records must not fall through to Telegraph');
        result = await run(upload, env, '/upload?permanent=true', { headers: adminHeaders, body: uploadBody() });
        assert.equal((await result.response.json())[0].expiresAt, null);
        result = await run(upload, env, '/upload', { headers: bearer('admin-token'), body: uploadBody() });
        assert.equal(typeof (await result.response.json())[0].expiresAt, 'number', 'admin uploads also default to 24h');

        // The session lifetime is independent; merge uses the init policy and rechecks privilege.
        const initBody = () => form({ originalFileName: 'chunks.txt', originalFileType: 'text/plain', totalChunks: '1' });
        result = await run(upload, env, '/upload?initChunked=true&expiresIn=172800', { body: initBody() });
        const { uploadId } = await result.response.json();
        const session = JSON.parse(await db.get(`upload_session_${uploadId}`));
        assert.equal(session.retention, 172800);
        assert.ok(session.expiresAt < Date.now() + 3601000);
        const mergeBody = () => form({ uploadId, originalFileName: 'chunks.txt', originalFileType: 'text/plain', totalChunks: '1' });
        result = await run(upload, env, '/upload?chunked=true&merge=true&expiresIn=86400', { body: mergeBody() });
        assert.equal(result.response.status, 400);
        await db.put(`chunk_${uploadId}_000`, '', { metadata: { status: 'completed', uploadResult: {
            fileId: 'tg-chunk', messageId: 101, chatId: -10001, messageDate: Math.floor(Date.now() / 1000),
            tgChannel: 'Telegram_env', size: 4, fileName: 'chunk.txt',
        } } });
        result = await run(upload, env, '/upload?chunked=true&merge=true', { body: mergeBody() });
        assert.equal(result.response.status, 200);
        const merged = (await result.response.json())[0];
        assert.ok(Math.abs(merged.expiresAt - Date.now() - 172800000) < 10000);
        stored = await db.getWithMetadata(merged.src.slice('/file/'.length));
        assert.equal(JSON.parse(stored.value)[0].messageId, 101);
        await db.put(`upload_session_${uploadId}`, JSON.stringify({ ...session, retention: null }));
        result = await run(upload, env, '/upload?chunked=true&merge=true', { headers: bearer('upload-only'), body: mergeBody() });
        assert.equal(result.response.status, 403);

        const hfBody = { fullId: 'hf.txt', filePath: 'hf.txt', sha256: 'a'.repeat(64), fileSize: 4, fileName: 'hf.txt', fileType: 'text/plain' };
        result = await run(commit, env, '/upload/huggingface/commitUpload?permanent=true', {
            headers: { ...bearer('upload-only'), 'Content-Type': 'application/json' }, body: JSON.stringify(hfBody),
        });
        assert.equal(result.response.status, 403);
        result = await run(commit, env, '/upload/huggingface/commitUpload', {
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hfBody),
        });
        assert.equal(result.response.status, 200);
        assert.equal(typeof (await result.response.json()).expiresAt, 'number');

        const expired = { Channel: 'CloudflareR2', ExpiresAt: Date.now() - 1 };
        await db.put('legacy.txt', '', { metadata: { Channel: 'CloudflareR2' } });
        await db.put('permanent.txt', '', { metadata: { ...expired, ExpiresAt: null } });
        await db.put('live.txt', '', { metadata: { ...expired, ExpiresAt: Date.now() + 86400000 } });
        for (const id of ['legacy.txt', 'permanent.txt', 'live.txt']) {
            assert.equal(await deleteExpiredFile(env, id), true);
            assert.ok((await db.getWithMetadata(id)).metadata, id);
        }
        await db.put('000-failure.txt', '', { metadata: expired });
        remoteFailure = true;
        assert.equal(await deleteExpiredFile(env, '000-failure.txt'), false);
        assert.ok((await db.getWithMetadata('000-failure.txt')).metadata);
        remoteFailure = false;
        assert.equal(await deleteExpiredFile(env, '000-failure.txt'), true);
        stored = await db.getWithMetadata(telegramId);
        await db.put(telegramId, stored.value, { metadata: { ...stored.metadata, ExpiresAt: Date.now() - 1 } });
        assert.equal(await deleteExpiredFile(env, telegramId), true);
        assert.equal(deletedMessages.at(-1).message_id, 100);
        assert.equal(deletedMessages.at(-1).chat_id, -10001);
        const messagesBefore = deletedMessages.length;
        await db.put('old-telegram.txt', '', { metadata: { Channel: 'TelegramNew', ExpiresAt: Date.now() - 1,
            TgMessageId: 200, TgMessageChatId: -10001, TgMessageDate: Math.floor(Date.now() / 1000) - 172800 } });
        assert.equal(await deleteExpiredFile(env, 'old-telegram.txt'), true);
        assert.equal(deletedMessages.length, messagesBefore, 'Telegram messages >=48h depend on chat auto-delete');
        await db.put('telegram-chunks.txt', JSON.stringify([{ messageId: 201, chatId: -10001,
            messageDate: Math.floor(Date.now() / 1000), channelName: 'Telegram_env' }]),
        { metadata: { Channel: 'TelegramNew', IsChunked: true, ExpiresAt: Date.now() - 1 } });
        remoteFailure = true;
        assert.equal(await deleteExpiredFile(env, 'telegram-chunks.txt'), false);
        assert.ok((await db.getWithMetadata('telegram-chunks.txt')).metadata);
        remoteFailure = false;
        assert.equal(await deleteExpiredFile(env, 'telegram-chunks.txt'), true);

        result = await run(cleanup, env, '/api/manage/cleanupExpired');
        assert.equal(result.response.status, 401);
        result = await run(cleanup, env, '/api/manage/cleanupExpired', { headers: bearer('upload-only') });
        assert.equal(result.response.status, 401);
        for (let i = 0; i < 12; i++) await db.put(`scan-${i}.txt`, '', { metadata: { Channel: 'External', ExpiresAt: Date.now() - 1 } });
        let deleted = 0, pages = 0, stats;
        do {
            stats = await cleanupExpiredFiles(env);
            assert.ok(stats.scanned <= 5);
            assert.equal(stats.failed, 0);
            deleted += stats.deleted;
            assert.ok(++pages < 100, 'cleanup cursor must eventually finish');
        } while (stats.hasMore);
        assert.equal(deleted, 12);
        assert.ok(pages > 1);
        await db.put('000-scheduled.txt', '', { metadata: { Channel: 'External', ExpiresAt: Date.now() - 1 } });
        const scheduledTasks = [];
        await worker.scheduled({}, env, { waitUntil: task => scheduledTasks.push(task) });
        await Promise.all(scheduledTasks);
        assert.equal((await db.getWithMetadata('000-scheduled.txt'))?.metadata ?? null, null);

        // Cached lists must retain the deadline and filter again when the file expires.
        await db.put('manage@sysConfig@others', JSON.stringify({
            publicBrowse: { enabled: true, allowedDir: 'browse' },
            randomImageAPI: { enabled: true, allowedDir: 'browse' },
        }));
        const now = Date.now();
        for (const [id, expiresAt] of [['live.jpg', now + 86400000], ['soon.jpg', now + 60000]]) {
            await db.put(`browse/${id}`, '', { metadata: { Channel: 'External', FileType: 'image/jpeg', TimeStamp: now, ExpiresAt: expiresAt } });
        }
        const indexTasks = [];
        assert.equal((await rebuildIndex({ env, waitUntil: task => indexTasks.push(task) })).success, true);
        await Promise.all(indexTasks);
        const browse = '/api/public/list?dir=browse';
        const firstList = await (await run(publicList, env, browse, { method: 'GET' })).response.json();
        assert.equal(firstList.totalCount, 2);
        assert.ok(firstList.files.every(file => typeof file.metadata.ExpiresAt === 'number'));
        await run(random, env, '/random?dir=browse', { method: 'GET' });
        const realNow = Date.now;
        Date.now = () => now + 120000;
        try {
            const cachedList = await (await run(publicList, env, browse, { method: 'GET' })).response.json();
            assert.equal(cachedList.fromCache, true);
            assert.equal(cachedList.totalCount, 1);
            assert.equal(cachedList.files[0].name, 'browse/live.jpg');
            const randomResponse = (await run(random, env, '/random?dir=browse', { method: 'GET' })).response;
            assert.equal((await randomResponse.json()).url, '/file/browse/live.jpg');
            assert.match(randomResponse.headers.get('Cache-Control'), /no-store/);
            assert.equal((await run(context => readIndex(context, { directory: 'browse', count: -1 }), env, '/api/manage/list')).response.files.length, 1);
        } finally {
            Date.now = realNow;
        }

        await db.put('manage@session@admin', JSON.stringify({ authType: 'admin', expiresAt: Date.now() - 1 }));
        assert.equal(await canStorePermanently(env, new Request('https://img.test', { headers: adminHeaders })), false);
        await db.put('manage@sysConfig@security', JSON.stringify({ ...config, auth: {} }));
        assert.equal(await canStorePermanently(env, new Request('https://img.test')), false, 'open admin UI must not grant permanent storage');
        console.log(`${name}: retention upload, auth, expiry, chunk, cleanup and scheduled checks passed`);
    }

    // If index persistence fails after remote deletion, keep references for an idempotent retry.
    const guardedKv = new Proxy(kv, { get(target, property) {
        if (property === 'put') return async (key, ...args) => {
            if (key.startsWith('manage@index@operation_')) throw new Error('simulated index failure');
            return target.put(key, ...args);
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    await kv.put('index-failure.txt', '', { metadata: { Channel: 'External', ExpiresAt: Date.now() - 1 } });
    assert.equal(await deleteExpiredFile({ img_url: guardedKv }, 'index-failure.txt'), false);
    assert.ok((await kv.getWithMetadata('index-failure.txt')).metadata);
    assert.equal(await deleteExpiredFile({ img_url: kv }, 'index-failure.txt'), true);
    assert.equal(await new DiscordAPI('local-token').deleteMessage('channel', 'missing'), true);
    remoteFailure = true;
    assert.equal(await new HuggingFaceAPI('local-token', 'local/check').deleteFile('missing.txt'), false, 'repository 404 is not proof of file deletion');
    hfMissing = true;
    assert.equal(await new HuggingFaceAPI('local-token', 'local/check').deleteFile('missing.txt'), true);
    console.log('File retention checks passed (local KV/D1; no real storage requests).');
} finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    await mf.dispose();
}
