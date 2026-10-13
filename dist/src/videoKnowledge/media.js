"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicIpv4 = publicIpv4;
exports.downloadMedia = downloadMedia;
exports.zernioRequest = zernioRequest;
exports.run = run;
exports.transcribeVideo = transcribeVideo;
const promises_1 = require("node:dns/promises");
const node_https_1 = __importDefault(require("node:https"));
const node_child_process_1 = require("node:child_process");
const promises_2 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function publicIpv4(ip) {
    const a = ip.split('.').map(Number);
    return a.length === 4 && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && ![0, 10, 127].includes(a[0]) && a[0] < 224 &&
        !(a[0] === 169 && a[1] === 254) && !(a[0] === 172 && a[1] >= 16 && a[1] <= 31) && !(a[0] === 192 && (a[1] === 168 || a[1] === 0)) &&
        !(a[0] === 100 && a[1] >= 64 && a[1] <= 127) && !(a[0] === 198 && (a[1] === 18 || a[1] === 19));
}
/** Resolve and pin a public IP on every redirect; never forward API credentials to media hosts. */
async function downloadMedia(raw, redirects = 0) {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || redirects > 3)
        throw new Error('Invalid media URL');
    const addresses = await (0, promises_1.lookup)(u.hostname, { family: 4, all: true });
    if (!addresses.length || addresses.some(x => !publicIpv4(x.address)))
        throw new Error('Media host is not public');
    return new Promise((resolve, reject) => {
        const req = node_https_1.default.get(u, { family: 4, lookup: (_host, _options, cb) => cb(null, addresses[0].address, 4) }, res => {
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
            const parts = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 40000000) {
                    res.destroy(new Error('Media exceeds 40 MB'));
                    return;
                }
                parts.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => resolve(Buffer.concat(parts)));
        });
        const deadline = setTimeout(() => req.destroy(new Error('Media download timed out')), 120000);
        req.on('close', () => clearTimeout(deadline));
        req.on('error', reject);
    });
}
async function zernioRequest(route, body) {
    const key = process.env.ZERNIO_DM_API_KEY?.trim();
    if (!key)
        throw new Error('Zernio key missing');
    const response = await fetch('https://zernio.com/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok)
        throw new Error(`Zernio video request failed (${response.status})`);
    return response.json();
}
function run(command, args, cwd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: cwd, TMPDIR: cwd, OMP_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', failed = false;
        const kill = () => {
            failed = true;
            try {
                if (process.platform !== 'win32' && child.pid)
                    process.kill(-child.pid, 'SIGKILL');
                else
                    child.kill('SIGKILL');
            }
            catch { }
        };
        const timer = setTimeout(kill, timeout);
        child.stdout.on('data', b => {
            output += b;
            if (output.length > 1000000)
                kill();
        });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('Video media tools unavailable')); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0 || failed)
                reject(new Error('Video media processing failed or timed out'));
            else
                resolve(output);
        });
    });
}
/** Victoria's URL downloader plus local Whisper. No paid download or speech API. */
async function transcribeVideo(video, deps = { execute: run, download: async (v, dir, execute) => (await Promise.resolve().then(() => __importStar(require('./downloader.js')))).downloadVideo(v, dir, execute) }) {
    const model = process.env.VIDEO_WHISPER_MODEL;
    if (!model)
        throw new Error('VIDEO_WHISPER_MODEL must point to an installed whisper.cpp model');
    const dir = await promises_2.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'property-video-'));
    try {
        const { file: media, duration: expected } = await deps.download(video, dir, deps.execute);
        const demuxer = { '.mp4': 'mov', '.m4a': 'mov', '.mp3': 'mp3', '.webm': 'matroska' }[node_path_1.default.extname(media)];
        if (!demuxer)
            throw Error('Unsupported media format');
        const probe = JSON.parse(await deps.execute('ffprobe', ['-v', 'error', '-f', demuxer, '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', media], dir));
        const duration = Number(probe.format?.duration);
        if (!probe.streams?.some((s) => s.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 1200 || !Number.isFinite(expected) || expected <= 0 || Math.abs(duration - expected) > Math.max(2, expected * 0.03))
            throw Error('Audio coverage incomplete or unsupported duration');
        const audio = node_path_1.default.join(dir, 'audio.wav');
        await deps.execute('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', demuxer, '-protocol_whitelist', 'file,pipe', '-i', media, '-t', '1200', '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audio], dir);
        if (Math.abs((await promises_2.default.stat(audio)).size / 32000 - duration) > Math.max(2, duration * 0.03))
            throw Error('Audio coverage incomplete');
        await deps.execute(process.env.VIDEO_WHISPER_BIN || 'whisper-cli', ['-m', model, '-f', audio, '-l', 'auto', '-t', '1', '-otxt', '-of', node_path_1.default.join(dir, 'transcript'), '-np'], dir, 900000);
        const text = (await promises_2.default.readFile(node_path_1.default.join(dir, 'transcript.txt'), 'utf8')).trim();
        if (text.length < 10 || text.length > 60000)
            throw Error('No usable complete speech transcript');
        return text;
    }
    finally {
        await promises_2.default.rm(dir, { recursive: true, force: true });
    }
}
