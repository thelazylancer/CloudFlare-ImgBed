// Pages has no Cron trigger. Each batch runs as a separate Pages request.
export async function runCleanup(env) {
    if (!env.IMGBED_URL || !env.IMGBED_MANAGE_TOKEN) throw new Error('Cleanup configuration missing');
    const endpoint = new URL('/api/manage/cleanupExpired', env.IMGBED_URL);
    if (endpoint.protocol !== 'https:') throw new Error('Cleanup requires HTTPS');
    const totals = { batches: 0, deleted: 0, failed: 0, hasMore: false };
    const deadline = Date.now() + 45000;
    // ponytail: 25 requests fit free Worker limits; the next scheduled run continues the saved cursor.
    while (totals.batches < 25 && Date.now() < deadline) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.IMGBED_MANAGE_TOKEN}` },
            signal: AbortSignal.timeout(Math.min(10000, deadline - Date.now())),
        });
        if (!response.ok) throw new Error(`Cleanup endpoint returned ${response.status}`);
        const result = await response.json();
        if (!Number.isInteger(result.deleted) || !Number.isInteger(result.failed) || typeof result.hasMore !== 'boolean') {
            throw new Error('Invalid cleanup response');
        }
        totals.batches++;
        totals.deleted += result.deleted;
        totals.failed += result.failed;
        totals.hasMore = result.hasMore;
        if (!result.hasMore) break;
        // KV permits one write per key per second; cleanup persists the shared cursor.
        await new Promise(resolve => setTimeout(resolve, 1100));
    }
    return totals;
}

export default {
    scheduled(_event, env, ctx) {
        ctx.waitUntil(runCleanup(env).then(result => console.log('Retention cleanup:', JSON.stringify(result))));
    },
};
