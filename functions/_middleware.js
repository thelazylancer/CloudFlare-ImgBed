const RETIRED_HOST = 'thelazy-imgs.pages.dev';
const CANONICAL_ORIGIN = 'https://imgs.thelazystudio.net';

export function onRequest(context) {
    const url = new URL(context.request.url);
    if (url.hostname.toLowerCase() === RETIRED_HOST) {
        return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308);
    }
    return context.next();
}
