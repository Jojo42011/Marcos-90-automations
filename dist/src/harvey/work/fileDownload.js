"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicDownload = publicDownload;
exports.downloadFile = downloadFile;
const node_https_1 = __importDefault(require("node:https"));
const promises_1 = require("node:dns/promises");
const node_fs_1 = require("node:fs");
const promises_2 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const promises_3 = require("node:stream/promises");
const media_js_1 = require("../../videoKnowledge/media.js");
const uploadFiles_js_1 = require("./uploadFiles.js");
async function publicDownload(raw, signal, redirects = 0) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || redirects > 4)
        throw new Error("Use a public HTTPS download URL without embedded credentials");
    const addresses = await (0, promises_1.lookup)(url.hostname, { family: 4, all: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(a => !(0, media_js_1.publicIpv4)(a.address)))
        throw new Error("Download address must be public");
    return new Promise((resolve, reject) => {
        const request = node_https_1.default.get(url, { signal, headers: { "Accept-Encoding": "identity" }, family: 4, lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4) }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
                response.destroy();
                publicDownload(new URL(response.headers.location, url).href, signal, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.destroy();
                reject(new Error("Download returned HTTP " + response.statusCode + ". Refresh the connector download link if it expired; website sign-in pages are not file downloads."));
                return;
            }
            const mime = String(response.headers['content-type'] || 'application/octet-stream').split(';')[0];
            if (mime === 'text/html') {
                response.destroy();
                reject(new Error("Download returned an HTML page, not file bytes. Obtain a direct download link through the authorized connector."));
                return;
            }
            resolve({ stream: response, mime, size: response.headers['content-length'] ? Number(response.headers['content-length']) : undefined });
        });
        request.on('error', reject);
    });
}
/** Stream to a private temporary file; publish only after length/hash validation. */
async function downloadFile(root, input, signal, open = publicDownload) {
    const name = input.filename;
    if (typeof name !== "string" || (0, node_path_1.basename)(name) !== name || name.startsWith('.') || !/^[a-zA-Z0-9 _.-]{1,140}$/.test(name))
        throw new Error("Choose a plain filename with the original extension");
    if (input.expectedSize !== undefined && (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0 || input.expectedSize > uploadFiles_js_1.MAX_WORKSPACE_FILE_BYTES))
        throw new Error("Expected size must be 1 byte to 1 GiB");
    const deadline = AbortSignal.timeout(8 * 60_000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    const space = await (0, promises_2.statfs)(root);
    if (space.bavail * space.bsize < (input.expectedSize || uploadFiles_js_1.MAX_WORKSPACE_FILE_BYTES) + 256 * 1024 * 1024)
        throw new Error("Insufficient workspace disk space for this download");
    const id = (0, node_crypto_1.randomUUID)(), part = (0, node_path_1.join)(root, '.download-' + id), file = (0, node_path_1.join)(root, id + '-' + name);
    let bytes = 0;
    const hash = (0, node_crypto_1.createHash)('sha256');
    try {
        const response = await open(input.url, combined);
        if (response.size !== undefined && (!Number.isSafeInteger(response.size) || response.size <= 0 || response.size > uploadFiles_js_1.MAX_WORKSPACE_FILE_BYTES)) {
            response.stream.destroy();
            throw new Error("Download exceeds 1 GiB or has an invalid length");
        }
        await (0, promises_3.pipeline)(response.stream, new node_stream_1.Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > uploadFiles_js_1.MAX_WORKSPACE_FILE_BYTES) {
                callback(new Error("Download exceeds 1 GiB"));
                return;
            } hash.update(chunk); callback(null, chunk); } }), (0, node_fs_1.createWriteStream)(part, { flags: 'wx', mode: 0o600 }), { signal: combined });
        if (!bytes || (response.size !== undefined && response.size !== bytes) || (input.expectedSize !== undefined && input.expectedSize !== bytes))
            throw new Error("Downloaded byte count does not match the expected file; incomplete bytes were discarded");
        await (0, promises_2.chmod)(part, 0o644);
        await (0, promises_2.rename)(part, file);
        return { name: (0, node_path_1.basename)(file), path: file, size: bytes, sha256: hash.digest('hex'), mime: response.mime, verified: true, note: "File bytes are now in this chat workspace. Select them with browser_file_upload after opening the site's chooser; verify the site finishes receiving them." };
    }
    catch (error) {
        await (0, promises_2.unlink)(part).catch(() => { });
        throw error;
    }
}
