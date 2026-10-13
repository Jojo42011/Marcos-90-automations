"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaProxy = mediaProxy;
exports.mediaFormats = mediaFormats;
exports.inspectVideo = inspectVideo;
exports.downloadVideo = downloadVideo;
const node_http_1 = __importDefault(require("node:http"));
const node_net_1 = __importDefault(require("node:net"));
const promises_1 = require("node:dns/promises");
const promises_2 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const media_js_1 = require("./media.js");
const store_js_1 = require("./store.js");
/** Victoria's public-media proxy: every CDN/redirect connection is resolved and pinned.
 * The downloader receives no application credentials, cookies or browser profile. */
async function mediaProxy() {
    const sockets = new Set();
    let transferred = 0;
    const server = node_http_1.default.createServer((_req, res) => { res.writeHead(403); res.end('HTTPS only'); });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('connect', async (req, client, head) => {
        const socket = client;
        try {
            const target = new URL('https://' + req.url);
            if (target.username || target.password || target.port && target.port !== '443' || target.pathname !== '/')
                throw Error('Invalid target');
            const addresses = await (0, promises_1.lookup)(target.hostname, { family: 4, all: true });
            if (!addresses.length || addresses.some(a => !(0, media_js_1.publicIpv4)(a.address)) || socket.destroyed)
                throw Error('Not public');
            const upstream = node_net_1.default.connect({ host: addresses[0].address, port: 443, family: 4 });
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.setTimeout(25000, () => upstream.destroy());
            socket.setTimeout(25000, () => socket.destroy());
            upstream.on('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length)
                upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
            upstream.on('data', chunk => { transferred += chunk.length; if (transferred > 85000000)
                for (const s of sockets)
                    s.destroy(); });
            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
            socket.on('close', () => upstream.destroy());
        }
        catch {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { for (const socket of sockets)
            socket.destroy(); await new Promise(r => server.close(() => r())); } };
}
function mediaFormats(metadata) {
    const formats = (metadata.formats || []).filter((f) => typeof f.format_id === 'string' && /^[\w.-]+$/.test(f.format_id) && f.protocol === 'https' && ['mp3', 'm4a', 'mp4', 'webm'].includes(f.ext) && f.acodec && f.acodec !== 'none' && (!f.filesize || f.filesize <= 40000000));
    // Audio first: a long property tour can exceed the video cap while its full speech fits.
    formats.sort((a, b) => Number(a.vcodec !== 'none' && a.format_id !== 'audio') - Number(b.vcodec !== 'none' && b.format_id !== 'audio') || (a.filesize || 40000000) - (b.filesize || 40000000));
    return [...new Set(formats.map((f) => f.format_id))].slice(0, 3);
}
async function inspectVideo(url, execute = media_js_1.run, proxyFactory = mediaProxy) {
    if (!(0, store_js_1.postId)(url))
        throw Error('Use a canonical TikTok video link');
    const dir = await promises_2.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'property-metadata-'));
    let proxy;
    try {
        proxy = await proxyFactory();
        const raw = await execute(process.env.VIDEO_YTDLP_BIN || 'yt-dlp', ['--ignore-config', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '1', '--proxy', proxy.url, '--js-runtimes', 'node:' + process.execPath, '--no-remote-components', '--no-playlist', '--skip-download', '--dump-single-json', '--', url], dir);
        const data = JSON.parse(raw);
        if (data.entries || data.is_live || String(data.id) !== (0, store_js_1.postId)(url) || (0, store_js_1.postId)(data.webpage_url) !== String(data.id))
            throw Error('Unexpected public video metadata');
        return data;
    }
    finally {
        await proxy?.close();
        await promises_2.default.rm(dir, { recursive: true, force: true });
    }
}
async function downloadVideo(video, dir, execute = media_js_1.run, proxyFactory = mediaProxy) {
    if (!(0, store_js_1.postId)(video.url) || (0, store_js_1.postId)(video.url) !== video.post)
        throw Error('Use a canonical TikTok video link');
    const proxy = await proxyFactory();
    try {
        const command = process.env.VIDEO_YTDLP_BIN || 'yt-dlp';
        const base = ['--ignore-config', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1', '--proxy', proxy.url, '--js-runtimes', 'node:' + process.execPath, '--no-remote-components', '--no-playlist'];
        const metadata = JSON.parse(await execute(command, [...base, '--skip-download', '--dump-single-json', '--', video.url], dir));
        const duration = Number(metadata.duration);
        if (metadata.entries || metadata.is_live || String(metadata.id) !== video.post || !Number.isFinite(duration) || duration <= 0 || duration > 1200)
            throw Error('Expected one complete recorded video up to 20 minutes');
        const info = node_path_1.default.join(dir, 'media.json');
        await promises_2.default.writeFile(info, JSON.stringify({ ...metadata, _type: 'video' }));
        for (const format of mediaFormats(metadata)) {
            try {
                await execute(command, [...base, '--max-filesize', '40M', '--downloader', 'native', '-f', format, '-o', node_path_1.default.join(dir, 'source.%(ext)s'), '--load-info-json', info], dir, 240000);
                const name = (await promises_2.default.readdir(dir)).find(f => /^source\.(mp3|m4a|mp4|webm)$/.test(f));
                if (name) {
                    const file = node_path_1.default.join(dir, name);
                    const size = (await promises_2.default.stat(file)).size;
                    if (size > 0 && size <= 40000000)
                        return { file, duration };
                }
            }
            catch { /* Try the next bounded public format; never bypass platform access restrictions. */ }
            for (const name of (await promises_2.default.readdir(dir)).filter(f => /^source\.[\w.-]+$/.test(f)))
                await promises_2.default.rm(node_path_1.default.join(dir, name), { force: true });
        }
        throw Error('No complete public audio within the 40 MB limit');
    }
    finally {
        await proxy.close();
    }
}
