import { getDatabase } from './databaseAdapter.js';
import { validateApiToken } from './auth/tokenValidator.js';
import { validateSession } from './auth/sessionManager.js';
import { fetchSecurityConfig } from './sysConfig.js';

export const DEFAULT_RETENTION_SECONDS = 86400;
export const MAX_RETENTION_SECONDS = 604800;

// Missing ExpiresAt belongs to a legacy file; null is explicitly permanent.
export function isTemporaryFile(metadata) {
    return typeof metadata?.ExpiresAt === 'number' && Number.isFinite(metadata.ExpiresAt);
}

export function isFileExpired(metadata, now = Date.now()) {
    return isTemporaryFile(metadata) && metadata.ExpiresAt <= now;
}

export async function hasAdminSession(env, request, securityConfig) {
    const config = securityConfig || await fetchSecurityConfig(env, { throwOnError: true });
    const admin = config.auth?.admin;
    if (!admin?.adminUsername?.trim() || !admin?.adminPassword?.trim()) return false;
    return (await validateSession(env, request, 'admin')).valid;
}

export async function canStorePermanently(env, request, securityConfig) {
    if (request.headers.has('Authorization')) {
        const db = getDatabase(env);
        return (await validateApiToken(request, db, 'upload')).valid &&
            (await validateApiToken(request, db, 'manage')).valid;
    }
    return hasAdminSession(env, request, securityConfig);
}

function invalidRetention(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

export function parseRetention(params) {
    for (const key of ['expiresIn', 'permanent']) {
        if (params.getAll(key).length > 1) throw invalidRetention(`Duplicate ${key} parameter`);
    }
    const permanent = params.get('permanent');
    if (permanent !== null && permanent !== 'true' && permanent !== 'false') {
        throw invalidRetention('permanent must be true or false');
    }
    if (permanent === 'true') {
        if (params.has('expiresIn')) throw invalidRetention('permanent and expiresIn cannot be combined');
        return null;
    }
    const value = params.get('expiresIn');
    if (value === null) return DEFAULT_RETENTION_SECONDS;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_RETENTION_SECONDS) {
        throw invalidRetention('expiresIn must be an integer between 1 and 604800 seconds');
    }
    return Number(value);
}

export async function authorizeRetention(context, seconds) {
    if (seconds === null && !await canStorePermanently(context.env, context.request, context.securityConfig)) {
        throw invalidRetention('Permanent storage requires an admin session or a Token with upload and manage permissions', 403);
    }
    return seconds;
}

export async function getUploadRetention(context) {
    return authorizeRetention(context, parseRetention(context.url.searchParams));
}

export function retentionErrorResponse(error) {
    return new Response(JSON.stringify({ error: error.message }), {
        status: error.status || 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// Apply the lifetime at final persistence, including automatic channel retries.
export async function storeUploadedFile(context, fileId, value, metadata) {
    const seconds = context.retention === undefined ? DEFAULT_RETENTION_SECONDS : context.retention;
    metadata.ExpiresAt = seconds === null ? null : Date.now() + seconds * 1000;
    try {
        await getDatabase(context.env).put(fileId, value, { metadata });
    } catch (error) {
        // Retrying another storage channel cannot repair a database outage.
        context.uploadPersistenceFailed = true;
        throw Object.assign(error, { status: 500 });
    }
    context.fileExpiresAt = metadata.ExpiresAt;
}
