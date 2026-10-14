"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARED_VIDEO = void 0;
exports.referenceId = referenceId;
exports.messageWithVideoReference = messageWithVideoReference;
exports.expandVideoLinks = expandVideoLinks;
/** Preserve identifiers only; never infer property facts from a preview or fetch arbitrary media. */
exports.SHARED_VIDEO = '[Shared video without a usable TikTok reference]';
function referenceId(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(u.hostname) || u.username || u.password || u.port)
            return null;
        return u.pathname.match(/^\/(?:@[^/]+\/video|embed\/v2)\/(\d+)\/?$/)?.[1] || null;
    }
    catch {
        return null;
    }
}
function messageWithVideoReference(message) {
    const text = (typeof message.text === 'string' ? message.text.trim() : '') || (typeof message.message === 'string' ? message.message.trim() : '');
    if (process.env.VIDEO_KNOWLEDGE_ENABLED !== 'true' || process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED !== 'true')
        return text;
    const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 10) : [];
    const urls = [];
    let shared = false;
    for (const item of attachments) {
        if (!item || typeof item !== 'object')
            continue;
        const a = item;
        if (!['share', 'share_post', 'video', 'image'].includes(String(a.type)))
            continue;
        shared = true;
        const payload = a.payload;
        const id = payload && typeof payload.videoId === 'string' && /^\d+$/.test(payload.videoId) ? payload.videoId : null;
        if (id)
            urls.push('https://www.tiktok.com/embed/v2/' + id);
        else if (typeof a.url === 'string' && referenceId(a.url))
            urls.push(a.url);
    }
    return [text, ...new Set(urls), ...(shared && !urls.length ? [exports.SHARED_VIDEO] : [])].filter(Boolean).join('\n');
}
/** Expand only TikTok's public share redirects, with no cookies, tokens or arbitrary hosts. */
async function expandVideoLinks(message, request = fetch) {
    const links = message.match(/https:\/\/[^\s<>]+/g) || [];
    let result = message;
    for (const raw of links.slice(0, 3)) {
        const clean = raw.replace(/[),.!?]+$/, '');
        let u;
        try {
            u = new URL(clean);
        }
        catch {
            continue;
        }
        if (!['vm.tiktok.com', 'vt.tiktok.com', 'www.tiktok.com', 'tiktok.com'].includes(u.hostname) || u.username || u.password || u.port || referenceId(clean))
            continue;
        if (!['vm.tiktok.com', 'vt.tiktok.com'].includes(u.hostname) && !u.pathname.startsWith('/t/'))
            continue;
        try {
            for (let hop = 0; hop < 3; hop++) {
                const response = await request(u.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2500) });
                const location = response.headers.get('location');
                await response.body?.cancel();
                if (![301, 302, 303, 307, 308].includes(response.status) || !location)
                    break;
                const next = new URL(location, u);
                if (next.protocol !== 'https:' || !['vm.tiktok.com', 'vt.tiktok.com', 'www.tiktok.com', 'tiktok.com'].includes(next.hostname) || next.username || next.password || next.port)
                    break;
                if (referenceId(next.href)) {
                    result = result.replace(raw, next.href);
                    break;
                }
                u = next;
            }
        }
        catch { /* Leave the unknown link for a truthful fallback. */ }
    }
    return result;
}
