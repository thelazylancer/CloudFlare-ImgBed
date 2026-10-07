import { cleanupExpiredFiles, getCleanupStatus } from '../../utils/retentionCleanup.js';
import { hasAdminSession } from '../../utils/fileRetention.js';
import { validateApiToken } from '../../utils/auth/tokenValidator.js';
import { getDatabase } from '../../utils/databaseAdapter.js';

async function handle({ env, request }) {
    const authorized = request.headers.has('Authorization')
        ? (await validateApiToken(request, getDatabase(env), 'manage')).valid
        : await hasAdminSession(env, request);
    if (!authorized) return new Response('Unauthorized', { status: 401 });
    const result = request.method === 'GET'
        ? await getCleanupStatus(env)
        : await cleanupExpiredFiles(env, new URL(request.url));
    return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

export const onRequestGet = handle;
export const onRequestPost = handle;
