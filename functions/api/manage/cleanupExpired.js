import { cleanupExpiredFiles } from '../../utils/retentionCleanup.js';
import { hasAdminSession } from '../../utils/fileRetention.js';
import { validateApiToken } from '../../utils/auth/tokenValidator.js';
import { getDatabase } from '../../utils/databaseAdapter.js';

export async function onRequestPost({ env, request }) {
    const authorized = request.headers.has('Authorization')
        ? (await validateApiToken(request, getDatabase(env), 'manage')).valid
        : await hasAdminSession(env, request);
    if (!authorized) return new Response('Unauthorized', { status: 401 });
    const result = await cleanupExpiredFiles(env, new URL(request.url));
    return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}
