import sentryPlugin from "@cloudflare/pages-plugin-sentry";
import '@sentry/tracing';
import { fetchOthersConfig } from "./sysConfig";
import { checkDatabaseConfig as checkDbConfig } from './databaseAdapter.js';

const TELEMETRY_HEADERS = ['content-type', 'user-agent', 'cf-ray'];

function scrubText(value, secrets = []) {
  if (typeof value !== 'string') return value;
  for (const secret of secrets) if (secret.length >= 4) value = value.split(secret).join('[redacted]');
  return value.replace(/https?:\/\/[^\s"'<>]+/g, text => {
    try {
      const url = new URL(text);
      return url.origin + url.pathname.replace(/\/bot[^/]+/g, '/bot[redacted]');
    } catch { return '[redacted URL]'; }
  }).replace(/(?:Bearer|Basic)\s+[a-zA-Z0-9._~+\/-]+/gi, '[redacted authorization]')
    .replace(/((?:token|authcode|password|secret|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function telemetryRequest(request) {
  const headers = {};
  const inputHeaders = new Headers(request.headers || {});
  for (const key of TELEMETRY_HEADERS) {
    const value = inputHeaders.get(key);
    if (value) headers[key] = scrubText(value);
  }
  return { ...(request.url ? { url: scrubText(request.url) } : {}), method: request.method, headers };
}

// Drop bodies, cookies and request details even when the SDK event has no URL.
export function sanitizeTelemetryEvent(event) {
  const secrets = [];
  for (const request of [event.request, event.contexts?.request]) {
    if (!request) continue;
    try { secrets.push(...new URL(request.url).searchParams.values()); } catch { /* no URL */ }
    const headers = new Headers(request.headers || {});
    secrets.push(headers.get('authorization')?.replace(/^(Bearer|Basic) /i, '') || '');
    secrets.push(...(headers.get('cookie') || '').split(';').map(cookie => cookie.substring(cookie.indexOf('=') + 1).trim()));
  }
  if (event.request) event.request = telemetryRequest(event.request);
  if (event.contexts) event.contexts = {
    ...(event.contexts.trace ? { trace: Object.fromEntries(Object.entries(event.contexts.trace)
      .filter(([key]) => ['trace_id', 'span_id', 'parent_span_id', 'op', 'status'].includes(key))
      .map(([key, value]) => [key, scrubText(value, secrets)])) } : {}),
    ...(event.contexts.request ? { request: telemetryRequest(event.contexts.request) } : {}),
  };
  event.tags = Object.fromEntries(Object.entries(event.tags || {})
    .filter(([key]) => ['path', 'method'].includes(key)).map(([key, value]) => [key, scrubText(value, secrets)]));
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.logentry;
  delete event.fingerprint;
  if (event.message) event.message = scrubText(event.message, secrets);
  if (event.transaction) event.transaction = scrubText(event.transaction, secrets);
  if (event.exception?.values) event.exception.values = event.exception.values.map(value => ({
    type: value.type, value: scrubText(value.value, secrets),
    ...(value.stacktrace ? { stacktrace: { frames: (value.stacktrace.frames || []).map(frame => ({
      filename: scrubText(frame.filename, secrets), function: frame.function,
      lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
    })) } } : {}),
  }));
  if (event.spans) event.spans = event.spans.map(span => Object.fromEntries(Object.entries(span)
    .filter(([key]) => ['trace_id', 'span_id', 'parent_span_id', 'op', 'status', 'start_timestamp', 'timestamp'].includes(key))
    .map(([key, value]) => [key, scrubText(value, secrets)])));
  return event;
}

export async function errorHandling(context) {
  const othersConfig = await fetchOthersConfig(context.env);
  context.data.telemetry = Boolean(othersConfig.telemetry.enabled && context.env.SENTRY_DSN);
  if (!context.data.telemetry) return context.next();
  const rate = Number(context.env.sampleRate ?? 0.001);
  return sentryPlugin({
    dsn: context.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.001,
    requestDataOptions: { allowedHeaders: TELEMETRY_HEADERS, allowedCookies: [], allowedSearchParams: [] },
    beforeSend: sanitizeTelemetryEvent,
    beforeSendTransaction: sanitizeTelemetryEvent,
  })(context);
}

export async function telemetryData(context) {
  if (!context.data.telemetry || !context.data.sentry) return context.next();
  try {
    const request = telemetryRequest(context.request);
    context.data.sentry.setTag('path', new URL(request.url).pathname);
    context.data.sentry.setTag('method', request.method);
    context.data.sentry.setContext('request', request);
    context.data.transaction = context.data.sentry.startTransaction({ name: `${request.method} ${new URL(request.url).hostname}` });
  } catch {
    // Instrumentation must not stop an upload or execute its handler twice.
    console.error('Failed to start upload telemetry');
  }
  try {
    return await context.next();
  } finally {
    try { context.data.transaction?.finish(); } catch { /* best effort telemetry */ }
  }
}

export async function traceData(context, span, op, name) {
  if (!context.data.telemetry || !context.data.transaction) return;
  if (span) span.finish();
  else return context.data.transaction.startChild({ op, name });
}

// 检查数据库是否配置
export async function checkDatabaseConfig(context) {
  var env = context.env;

  var dbConfig = checkDbConfig(env);

  if (!dbConfig.configured) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "数据库未配置 / Database not configured",
        message: "请配置 KV 存储 (env.img_url) 或 D1 数据库 (env.img_d1)。 / Please configure KV storage (env.img_url) or D1 database (env.img_d1)."
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  // 继续执行
  return await context.next();
}
