const RETIRED_HOST = 'thelazy-imgs.pages.dev';
const CANONICAL_ORIGIN = 'https://imgs.thelazystudio.net';

// 自定义适配器通过请求上下文声明平台；Pages 使用原生 Functions 入口。
// 覆盖同名环境变量，避免用户配置将 Pages/Workers 误判为 Node。
export function onRequest(context) {
    if (context.request?.url) {
        const url = new URL(context.request.url);
        if (url.hostname.toLowerCase() === RETIRED_HOST) {
            return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308);
        }
    }
    const runtime = context.data.serverRuntime;
    context.env.SERVER_RUNTIME = runtime === 'node' || runtime === 'worker' ? runtime : 'pages';
    return context.next();
}
