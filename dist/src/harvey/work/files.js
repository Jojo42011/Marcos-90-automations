"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filesDir = filesDir;
exports.filePath = filePath;
exports.files = files;
exports.editVideo = editVideo;
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
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
function files(owner, chat) { const dir = filesDir(owner, chat); return (0, fs_1.readdirSync)(dir).filter(n => !n.startsWith(".") && (0, fs_1.statSync)((0, path_1.join)(dir, n)).isFile()).map(name => ({ name, size: (0, fs_1.statSync)((0, path_1.join)(dir, name)).size, path: (0, path_1.join)(dir, name) })); }
async function editVideo(owner, chat, input) {
    const source = filePath(owner, chat, String(input.file || ""));
    const start = Number(input.startSeconds || 0), duration = Number(input.durationSeconds);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 3600)
        throw new Error("Choose a nonnegative start and a duration up to one hour");
    const name = `edited-${(0, crypto_1.randomUUID)()}.mp4`, output = (0, path_1.join)(filesDir(owner, chat), name);
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg", "-ss", String(start), "-i", source, "-t", String(duration), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-threads", "2"];
    if (input.mute === true)
        args.push("-an");
    else
        args.push("-c:a", "aac");
    args.push("-movflags", "+faststart", output);
    await new Promise((resolve, reject) => { const child = (0, child_process_1.spawn)(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("Video edit timed out after ten minutes")); }, 600000); child.stderr.on("data", b => { stderr = (stderr + b).slice(-2000); }); child.on("error", () => { clearTimeout(timer); reject(new Error("FFmpeg is not installed on this worker")); }); child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Video edit failed: " + stderr)); }); });
    return { file: name, path: output, download: `/api/harvey/work/files/${chat}/${name}`, note: "Trim/transcode completed. Review the output before publishing." };
}
