import { getDatabase, checkDatabaseConfig, RETENTION_INDEX_PREFIX, retentionIndexKey } from './databaseAdapter.js';
import { isFileExpired, isTemporaryFile } from './fileRetention.js';
import { deleteFile } from '../api/manage/delete/[[path]].js';

const STATUS_KEY = 'manage@retention@cleanupStatus';
// ponytail: small batches fit free Worker subrequest budgets; schedulers continue in separate requests.
const PAGE_SIZE = 3;
const BACKFILL_PAGE_SIZE = 5;

export async function deleteExpiredFile(env, fileId, url = null) {
    return deleteFile(env, fileId, url ? `${url.origin}/file/${fileId}` : null, url, { expiredOnly: true });
}

async function readStatus(db) {
    const value = await db.get(STATUS_KEY);
    return value ? JSON.parse(value) : { totalDeleted: 0, recentFailures: [] };
}

export async function getCleanupStatus(env) {
    const state = await readStatus(getDatabase(env));
    const { cursor, backfillCursor, d1IndexReady, ...status } = state;
    return status;
}

export async function cleanupExpiredFiles(env, url = null) {
    const db = getDatabase(env);
    const state = await readStatus(db);
    const result = { scanned: 0, deleted: 0, failed: 0, indexed: 0, hasMore: false };
    const failures = new Map((state.recentFailures || []).map(item => [item.fileId, item]));
    state.lastRunAt = Date.now();
    try {
        let page;
        if (checkDatabaseConfig(env).usingKV) {
            // One resumable pass indexes temporary files created before the expiry index existed.
            if (!state.backfillComplete) {
                let legacy;
                try {
                    legacy = await db.list({ limit: BACKFILL_PAGE_SIZE, ...(state.backfillCursor ? { cursor: state.backfillCursor } : {}) });
                } catch (error) {
                    state.backfillCursor = null;
                    throw error;
                }
                for (const key of legacy.keys) {
                    if (!key.name.startsWith('manage@') && isTemporaryFile(key.metadata)) {
                        await env.img_url.put(await retentionIndexKey(key.name, key.metadata.ExpiresAt), '', {
                            metadata: { fileId: key.name, expiresAt: key.metadata.ExpiresAt },
                        });
                        result.indexed++;
                    }
                }
                state.backfillCursor = legacy.list_complete ? null : legacy.cursor;
                state.backfillComplete = legacy.list_complete;
            }
            try {
                page = await db.list({ prefix: RETENTION_INDEX_PREFIX, limit: PAGE_SIZE, ...(state.cursor ? { cursor: state.cursor } : {}) });
            } catch (error) {
                state.cursor = null;
                throw error;
            }
        } else {
            if (!state.d1IndexReady) {
                await env.img_d1.prepare("CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(json_extract(metadata, '$.ExpiresAt'), id) WHERE json_type(metadata, '$.ExpiresAt') IN ('integer', 'real')").run();
                state.d1IndexReady = true;
            }
            state.backfillComplete = true;
            page = await db.listExpiredFiles(Date.now(), PAGE_SIZE, state.cursor || '');
        }
        let reachedFuture = false;
        for (const key of page.keys) {
            const indexed = key.name.startsWith(RETENTION_INDEX_PREFIX);
            if (indexed && key.metadata?.expiresAt > Date.now()) {
                reachedFuture = true;
                break;
            }
            result.scanned++;
            const fileId = indexed ? key.metadata?.fileId : key.name;
            if (!fileId) {
                await db.delete(key.name);
                continue;
            }
            const file = await db.getWithMetadata(fileId);
            if (!isFileExpired(file?.metadata)) {
                if (indexed) await db.delete(key.name);
                failures.delete(fileId);
                continue;
            }
            if (await deleteExpiredFile(env, fileId, url)) {
                result.deleted++;
                failures.delete(fileId);
                if (indexed) await db.delete(key.name);
            } else {
                result.failed++;
                failures.set(fileId, { fileId, failedAt: Date.now() });
            }
        }
        state.cursor = reachedFuture || page.list_complete ? null : page.cursor;
        result.hasMore = Boolean(state.cursor || !state.backfillComplete);
        state.lastError = null;
        if (!result.hasMore) state.lastCompletedAt = Date.now();
    } catch (error) {
        state.lastError = 'Cleanup did not complete; retry the next batch';
        throw error;
    } finally {
        state.totalDeleted = (state.totalDeleted || 0) + result.deleted;
        state.recentFailures = Array.from(failures.values()).slice(-10);
        state.lastResult = result;
        await db.put(STATUS_KEY, JSON.stringify(state));
    }
    return { ...result, backfillComplete: state.backfillComplete, lastRunAt: state.lastRunAt };
}
