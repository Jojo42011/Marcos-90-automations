import { lookup } from "node:dns/promises";
import https from "node:https";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Video } from "./store.js";
export function publicIpv4(ip: string): boolean {
    const a = ip.split('.').map(Number);
    return a.length === 4 && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && ![0, 10, 127].includes(a[0]!) && a[0]! < 224 &&
        !(a[0] === 169 && a[1] === 254) && !(a[0] === 172 && a[1]! >= 16 && a[1]! <= 31) && !(a[0] === 192 && (a[1] === 168 || a[1] === 0)) &&
        !(a[0] === 100 && a[1]! >= 64 && a[1]! <= 127) && !(a[0] === 198 && (a[1] === 18 || a[1] === 19));
}
/** Resolve and pin a public IP on every redirect; never forward API credentials to media hosts. */
export async function downloadMedia(raw: string, redirects = 0): Promise<Buffer> {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || redirects > 3)
        throw new Error('Invalid media URL');
    const addresses = await lookup(u.hostname, { family: 4, all: true });
    if (!addresses.length || addresses.some(x => !publicIpv4(x.address)))
        throw new Error('Media host is not public');
    return new Promise((resolve, reject) => {
        const req = https.get(u, { family: 4, lookup: (_host, _options, cb) => cb(null, addresses[0]!.address, 4) }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
                res.resume();
                void downloadMedia(new URL(res.headers.location, u).href, redirects + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > 40000000) {
                res.destroy();
                reject(new Error('Media unavailable or exceeds 40 MB'));
                return;
            }
            const parts: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 40000000) {
                res.destroy(new Error('Media exceeds 40 MB'));
                return;
            } parts.push(chunk); });
            res.on('error', reject);
            res.on('end', () => resolve(Buffer.concat(parts)));
        });
        const deadline = setTimeout(() => req.destroy(new Error('Media download timed out')), 120000);
        req.on('close', () => clearTimeout(deadline));
        req.on('error', reject);
    });
}
export async function zernioRequest(route: string, body?: unknown): Promise<any> {
    const key = process.env.ZERNIO_DM_API_KEY?.trim();
    if (!key)
        throw new Error('Zernio key missing');
    const response = await fetch('https://zernio.com/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok)
        throw new Error(`Zernio video request failed (${response.status})`);
    return response.json();
}
export function run(command: string, args: string[], cwd: string, timeout = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: cwd, TMPDIR: cwd, OMP_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', failed = false;
        const kill = () => { failed = true; try {
            if (process.platform !== 'win32' && child.pid)
                process.kill(-child.pid, 'SIGKILL');
            else
                child.kill('SIGKILL');
        }
        catch { } };
        const timer = setTimeout(kill, timeout);
        child.stdout.on('data', b => { output += b; if (output.length > 1000000)
            kill(); });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('Video media tools unavailable')); });
        child.on('close', code => { clearTimeout(timer); if (code !== 0 || failed)
            reject(new Error('Video media processing failed or timed out'));
        else
            resolve(output); });
    });
}
/** Local whisper.cpp, following Victoria's earlier implementation. No paid speech API. */
export async function transcribeVideo(video: Video, deps = { request: zernioRequest, download: downloadMedia, execute: run }): Promise<string> {
    const model = process.env.VIDEO_WHISPER_MODEL;
    if (!model)
        throw new Error('VIDEO_WHISPER_MODEL must point to an installed whisper.cpp model');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'property-video-'));
    try {
        const result = await deps.request('/tools/tiktok/download?url=' + encodeURIComponent(video.url));
        if (typeof result.downloadUrl !== 'string')
            throw new Error('Zernio did not return downloadable media');
        const media = path.join(dir, 'source.mp4');
        const bytes = await deps.download(result.downloadUrl);
        if (!bytes.subarray(0, 64).includes(Buffer.from('ftyp'))) throw new Error('Expected an MP4 video');
        await fs.writeFile(media, bytes);
        const probe = JSON.parse(await deps.execute('ffprobe', ['-v', 'error', '-f', 'mov', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', media], dir));
        const duration = Number(probe.format?.duration);
        if (!probe.streams?.some((s: any) => s.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 1200)
            throw new Error('Expected an audio/video clip up to 20 minutes');
        const audio = path.join(dir, 'audio.wav');
        await deps.execute('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'mov', '-protocol_whitelist', 'file,pipe', '-i', media, '-t', '1200', '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audio], dir);
        const size = (await fs.stat(audio)).size;
        if (Math.abs(size / 32000 - duration) > Math.max(2, duration * 0.03))
            throw new Error('Audio coverage incomplete');
        await deps.execute(process.env.VIDEO_WHISPER_BIN || 'whisper-cli', ['-m', model, '-f', audio, '-l', 'auto', '-t', '1', '-otxt', '-of', path.join(dir, 'transcript'), '-np'], dir, 900000);
        const text = (await fs.readFile(path.join(dir, 'transcript.txt'), 'utf8')).trim();
        if (text.length < 10 || text.length > 60000)
            throw new Error('No usable complete speech transcript');
        return text;
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
