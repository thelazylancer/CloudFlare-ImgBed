import { getDatabase } from './databaseAdapter.js';
import { isFileExpired } from './fileRetention.js';
import { deleteFile } from '../api/manage/delete/[[path]].js';

const CURSOR_KEY = 'manage@retention@cleanupCursor';
// ponytail: scan 5 keys per minute to fit free Worker subrequest limits; use an expiry index at scale.
const PAGE_SIZE = 5;

export async function deleteExpiredFile(env, fileId, url = null) {
    return deleteFile(env, fileId, url ? `${url.origin}/file/${fileId}` : null, url, { expiredOnly: true });
}

export async function cleanupExpiredFiles(env, url = null) {
    const db = getDatabase(env);
    const cursor = await db.get(CURSOR_KEY);
    let page;
    try {
        page = await db.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    } catch (error) {
        // A replaced KV namespace/database can invalidate a saved cursor.
        await db.delete(CURSOR_KEY);
        throw error;
    }
    const result = { scanned: page.keys.length, deleted: 0, failed: 0, hasMore: !page.list_complete };
    for (const key of page.keys) {
        if (!isFileExpired(key.metadata)) continue;
        if (await deleteExpiredFile(env, key.name, url)) result.deleted++;
        else result.failed++;
    }
    if (!page.list_complete && page.cursor) await db.put(CURSOR_KEY, page.cursor);
    else await db.delete(CURSOR_KEY);
    return result;
}
