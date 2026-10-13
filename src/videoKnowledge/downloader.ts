import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {publicIpv4, run} from './media.js';
import {postId, type Video} from './store.js';

/** Victoria's public-media proxy: every CDN/redirect connection is resolved and pinned.
 * The downloader receives no application credentials, cookies or browser profile. */
export async function mediaProxy() {
    const sockets = new Set<net.Socket>(); let transferred = 0;
    const server = http.createServer((_req, res) => { res.writeHead(403); res.end('HTTPS only'); });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('connect', async (req, client, head) => {
        const socket = client as net.Socket;
        try {
            const target = new URL('https://' + req.url);
            if (target.username || target.password || target.port && target.port !== '443' || target.pathname !== '/') throw Error('Invalid target');
            const addresses = await lookup(target.hostname, {family: 4, all: true});
            if (!addresses.length || addresses.some(a => !publicIpv4(a.address)) || socket.destroyed) throw Error('Not public');
            const upstream = net.connect({host: addresses[0]!.address, port: 443, family: 4});
            sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
            upstream.setTimeout(25000, () => upstream.destroy()); socket.setTimeout(25000, () => socket.destroy());
            upstream.on('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
            upstream.on('data', chunk => { transferred += chunk.length; if (transferred > 85000000) for (const s of sockets) s.destroy(); });
            upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
        } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); }};
}

export function mediaFormats(metadata: any): string[] {
    const formats = (metadata.formats || []).filter((f: any) => typeof f.format_id === 'string' && /^[\w.-]+$/.test(f.format_id) && f.protocol === 'https' && ['mp3', 'm4a', 'mp4', 'webm'].includes(f.ext) && f.acodec && f.acodec !== 'none' && (!f.filesize || f.filesize <= 40000000));
    // Audio first: a long property tour can exceed the video cap while its full speech fits.
    formats.sort((a: any, b: any) => Number(a.vcodec !== 'none' && a.format_id !== 'audio') - Number(b.vcodec !== 'none' && b.format_id !== 'audio') || (a.filesize || 40000000) - (b.filesize || 40000000));
    return [...new Set<string>(formats.map((f: any) => f.format_id))].slice(0, 3);
}

export async function inspectVideo(url: string, execute = run, proxyFactory = mediaProxy): Promise<any> {
    if (!postId(url)) throw Error('Use a canonical TikTok video link');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'property-metadata-'));
    let proxy: Awaited<ReturnType<typeof mediaProxy>> | undefined;
    try {
        proxy=await proxyFactory();
        const raw=await execute(process.env.VIDEO_YTDLP_BIN||'yt-dlp',['--ignore-config','--no-warnings','--no-progress','--socket-timeout','20','--retries','1','--proxy',proxy.url,'--js-runtimes','node:'+process.execPath,'--no-remote-components','--no-playlist','--skip-download','--dump-single-json','--',url],dir);
        const data=JSON.parse(raw);
        if(data.entries||data.is_live||String(data.id)!==postId(url)||postId(data.webpage_url)!==String(data.id))throw Error('Unexpected public video metadata');
        return data;
    } finally { await proxy?.close(); await fs.rm(dir,{recursive:true,force:true}); }
}

export async function downloadVideo(video: Pick<Video, 'url' | 'post'>, dir: string, execute = run, proxyFactory = mediaProxy): Promise<{file: string; duration: number}> {
    if (!postId(video.url) || postId(video.url) !== video.post) throw Error('Use a canonical TikTok video link');
    const proxy = await proxyFactory();
    try {
        const command = process.env.VIDEO_YTDLP_BIN || 'yt-dlp';
        const base = ['--ignore-config', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1', '--proxy', proxy.url, '--js-runtimes', 'node:' + process.execPath, '--no-remote-components', '--no-playlist'];
        const metadata = JSON.parse(await execute(command, [...base, '--skip-download', '--dump-single-json', '--', video.url], dir));
        const duration = Number(metadata.duration);
        if (metadata.entries || metadata.is_live || String(metadata.id) !== video.post || !Number.isFinite(duration) || duration <= 0 || duration > 1200) throw Error('Expected one complete recorded video up to 20 minutes');
        const info = path.join(dir, 'media.json');
        await fs.writeFile(info, JSON.stringify({...metadata, _type: 'video'}));
        for (const format of mediaFormats(metadata)) {
            try {
                await execute(command, [...base, '--max-filesize', '40M', '--downloader', 'native', '-f', format, '-o', path.join(dir, 'source.%(ext)s'), '--load-info-json', info], dir, 240000);
                const name = (await fs.readdir(dir)).find(f => /^source\.(mp3|m4a|mp4|webm)$/.test(f));
                if (name) { const file = path.join(dir, name); const size = (await fs.stat(file)).size; if (size > 0 && size <= 40000000) return {file, duration}; }
            } catch { /* Try the next bounded public format; never bypass platform access restrictions. */ }
            for (const name of (await fs.readdir(dir)).filter(f => /^source\.[\w.-]+$/.test(f))) await fs.rm(path.join(dir, name), {force: true});
        }
        throw Error('No complete public audio within the 40 MB limit');
    } finally { await proxy.close(); }
}
