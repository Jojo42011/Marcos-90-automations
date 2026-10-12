"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filesDir = filesDir;
exports.filePath = filePath;
exports.files = files;
exports.inspectVideo = inspectVideo;
exports.editVideo = editVideo;
exports.workspaceFiles = workspaceFiles;
exports.publicFileLinks = publicFileLinks;
const fs_1 = require("fs");
const path_1 = require("path");
const uploadFiles_js_1 = require("./uploadFiles.js");
const video_js_1 = require("./video.js");
const browser_js_1 = require("./browser.js");
function filesDir(owner, chat) { const dir = (0, path_1.join)((0, browser_js_1.browserDirectory)(owner, chat), "files"); (0, fs_1.mkdirSync)(dir, { recursive: true }); return dir; }
function filePath(owner, chat, name) {
    if (!name || (0, path_1.basename)(name) !== name || name.startsWith("."))
        throw new Error("Use a file name from this chat's workspace");
    const root = (0, fs_1.realpathSync)(filesDir(owner, chat)), p = (0, fs_1.realpathSync)((0, path_1.join)(root, name));
    if (!p.startsWith(root + path_1.sep))
        throw new Error("File is outside this chat");
    return p;
}
function files(owner, chat) { const dir = filesDir(owner, chat); return (0, fs_1.readdirSync)(dir).filter(n => !n.startsWith(".") && (0, fs_1.statSync)((0, path_1.join)(dir, n)).isFile()).map(name => ({ name, size: (0, fs_1.statSync)((0, path_1.join)(dir, name)).size, path: (0, path_1.join)(dir, name), download: `/api/harvey/work/files/${chat}/${encodeURIComponent(name)}` })); }
function mediaPath(owner, chat, raw) {
    const root = (0, fs_1.realpathSync)(filesDir(owner, chat)), p = (0, fs_1.realpathSync)((0, path_1.resolve)(root, raw));
    if (!p.startsWith(root + path_1.sep) || !(0, fs_1.statSync)(p).isFile())
        throw new Error("Video must be a file in this chat workspace");
    return p;
}
async function inspectVideo(owner, chat, input, signal) {
    try {
        return await (0, video_js_1.inspectVideoPath)(mediaPath(owner, chat, String(input.file || "")), signal);
    }
    catch (error) {
        signal?.throwIfAborted();
        return (0, video_js_1.videoFailure)(error);
    }
}
async function editVideo(owner, chat, input, signal) {
    try {
        const result = await (0, video_js_1.exportVideo)(filesDir(owner, chat), mediaPath(owner, chat, String(input.file || "")), input.matchFile ? mediaPath(owner, chat, String(input.matchFile)) : undefined, input, signal);
        return "file" in result ? { ...result, download: `/api/harvey/work/files/${chat}/${result.file}` } : result;
    }
    catch (error) {
        signal?.throwIfAborted();
        return (0, video_js_1.videoFailure)(error);
    }
}
function workspaceFiles(owner, chat, input = {}) {
    if (input.file)
        return (0, uploadFiles_js_1.uploadFile)(filesDir(owner, chat), input.file, input.filename);
    const diagnostics = /^(?:page-.*\.(?:yml|jpeg|png)|console-.*\.log)$/;
    const all = files(owner, chat).filter(f => input.includeDiagnostics === true || !diagnostics.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const limit = 20;
    return { files: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null, note: "Only real local files are listed. Diagnostic screenshots/logs are hidden by default. Use file to inspect or filename to prepare a non-destructive upload alias." };
}
/** Correct only links to files actually present in this chat; never publish disk paths. */
function publicFileLinks(owner, chat, speech) {
    if (!/\]\(\/(?:workspace|data)\/harvey-work\//.test(speech))
        return speech;
    const links = new Map();
    for (const file of files(owner, chat)) {
        links.set(file.path, file.download);
        links.set(file.path.replace(/^\/data\//, "/workspace/"), file.download);
    }
    return speech.replace(/\]\(([^)\s]+)\)/g, (whole, path) => links.has(path) ? `](${links.get(path)})` : whole);
}
