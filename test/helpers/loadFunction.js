import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as retention from '../../functions/utils/fileRetention.js';

let sequence = 0;

// Exercise real modules while isolating external dependencies. MIME imports
// always use the shared utility; serverImports.mjs also checks unmodified imports
// with the production loader, which this isolated loader cannot validate.
function withForkDefaults(mocks) {
    // Upstream tests mock every import except MIME helpers. This fork also
    // imports retention helpers; supply the real checks and a database write
    // that stays on the test double.
    return {
        isFileExpired: retention.isFileExpired,
        isTemporaryFile: retention.isTemporaryFile,
        parseRetention: retention.parseRetention,
        authorizeRetention: retention.authorizeRetention,
        getUploadRetention: retention.getUploadRetention,
        retentionErrorResponse: retention.retentionErrorResponse,
        hasAdminSession: retention.hasAdminSession,
        canStorePermanently: retention.canStorePermanently,
        DEFAULT_RETENTION_SECONDS: retention.DEFAULT_RETENTION_SECONDS,
        MAX_RETENTION_SECONDS: retention.MAX_RETENTION_SECONDS,
        async storeUploadedFile(context, fileId, value, metadata) {
            const seconds = context.retention === undefined ? retention.DEFAULT_RETENTION_SECONDS : context.retention;
            metadata.ExpiresAt = seconds === null ? null : Date.now() + seconds * 1000;
            const database = mocks.getDatabase?.(context.env);
            if (database) await database.put(fileId, value, { metadata });
        },
        async deleteExpiredFile() {},
        ...mocks,
    };
}

export async function loadFunction(path, mocks = {}, globals = {}) {
    const filename = resolve(path);
    const key = `__functionTest${sequence++}`;
    globalThis[key] = { mocks: withForkDefaults(mocks), globals };
    let source = await readFile(filename, 'utf8');
    source = source.replace(/^import\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"];\r?\n/gm, (_, names, specifier) => {
        if (/\/mimeTypes(?:\.js)?$/.test(specifier)) {
            const mimePath = specifier.endsWith('.js') ? specifier : `${specifier}.js`;
            return `import {${names}} from ${JSON.stringify(pathToFileURL(resolve(dirname(filename), mimePath)).href)};\n`;
        }
        return `const {${names.replace(/\s+as\s+/g, ':')}} = globalThis.${key}.mocks;\n`;
    });
    source = source.replace(/export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g, (_, names, specifier) =>
        `export {${names}} from ${JSON.stringify(pathToFileURL(resolve(dirname(filename), specifier)).href)}`);
    source = `const {${Object.keys(globals).join(',')}} = globalThis.${key}.globals;\n${source}\n//# sourceURL=${pathToFileURL(filename).href}\n`;
    try {
        return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    } finally {
        delete globalThis[key];
    }
}

export function memoryDatabase() {
    const records = new Map();
    return {
        records,
        async get(key) { return records.get(key)?.value ?? null; },
        async getWithMetadata(key) { return structuredClone(records.get(key) ?? null); },
        async put(key, value, options = {}) { records.set(key, { value, metadata: structuredClone(options.metadata || {}) }); },
        async delete(key) { records.delete(key); },
        async list({ prefix = '' } = {}) {
            return {
                keys: [...records.keys()].filter(key => key.startsWith(prefix)).sort().map(name => ({ name, metadata: structuredClone(records.get(name).metadata) })),
                list_complete: true,
            };
        },
    };
}
