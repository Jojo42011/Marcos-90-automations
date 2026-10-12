"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_WORKSPACE_FILE_BYTES = void 0;
exports.uploadFile = uploadFile;
exports.uploadArguments = uploadArguments;
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
exports.MAX_WORKSPACE_FILE_BYTES = 1024 * 1024 * 1024;
function uploadFile(root, raw, filename) {
    if (typeof raw !== "string" || !raw.trim())
        throw new Error("Choose a file from workspace_files");
    const base = (0, fs_1.realpathSync)(root), lexical = (0, path_1.resolve)(root, raw);
    if (!lexical.startsWith(base + path_1.sep))
        throw new Error("Upload files must belong to this chat's browser workspace");
    const path = (0, fs_1.realpathSync)(lexical);
    if (!path.startsWith(base + path_1.sep))
        throw new Error("Upload file resolves outside this chat workspace");
    const info = (0, fs_1.statSync)(path);
    if (!info.isFile() || info.size === 0 || info.size > exports.MAX_WORKSPACE_FILE_BYTES)
        throw new Error("Upload requires a nonempty regular file of at most 1 GiB");
    (0, fs_1.accessSync)(path, fs_1.constants.R_OK);
    const head = Buffer.alloc(32), fd = (0, fs_1.openSync)(path, "r");
    try {
        (0, fs_1.readSync)(fd, head, 0, head.length, 0);
    }
    finally {
        (0, fs_1.closeSync)(fd);
    }
    let mime = "application/octet-stream", extension = "";
    if (head.toString("ascii", 4, 8) === "ftyp") {
        extension = head.toString("ascii", 8, 12) === "qt  " ? ".mov" : ".mp4";
        mime = extension === ".mov" ? "video/quicktime" : "video/mp4";
    }
    else if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        extension = ".png";
        mime = "image/png";
    }
    else if (head[0] === 255 && head[1] === 216 && head[2] === 255) {
        extension = ".jpg";
        mime = "image/jpeg";
    }
    else if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
        extension = ".webp";
        mime = "image/webp";
    }
    let uploadPath = path;
    // Retain the original download. Hard links give extensionless browser downloads a
    // useful upload name without copying hundreds of MB or rewriting the media.
    if (filename || (!(0, path_1.extname)(path) && extension)) {
        const name = filename || (0, path_1.basename)(path) + extension;
        if ((0, path_1.basename)(name) !== name || name.startsWith(".") || !/^[a-zA-Z0-9 _.-]{1,140}$/.test(name))
            throw new Error("Use a plain upload filename, not a path");
        if (extension && ![extension, ...(extension === ".jpg" ? [".jpeg"] : [])].includes((0, path_1.extname)(name).toLowerCase()))
            throw new Error("Upload filename extension must match detected file content: " + extension);
        const folder = (0, path_1.join)(base, ".uploads");
        (0, fs_1.mkdirSync)(folder, { recursive: true });
        if ((0, fs_1.realpathSync)(folder) !== folder)
            throw new Error("Upload alias directory must not be a symbolic link");
        uploadPath = (0, path_1.join)(folder, name);
        if ((0, fs_1.existsSync)(uploadPath)) {
            const old = (0, fs_1.statSync)(uploadPath);
            if (old.ino !== info.ino || old.dev !== info.dev)
                uploadPath = (0, path_1.join)(folder, (0, crypto_1.randomUUID)() + "-" + name);
        }
        if (!(0, fs_1.existsSync)(uploadPath))
            (0, fs_1.linkSync)(path, uploadPath);
    }
    return { path: uploadPath, originalPath: path, name: (0, path_1.basename)(uploadPath), size: info.size, mime, detectedExtension: extension || null };
}
function uploadArguments(root, input) {
    if (input.cancel === true) {
        if (input.paths?.length || input.files?.length)
            throw new Error("Choose upload paths or cancel, not both");
        return { paths: [] };
    }
    if (input.paths !== undefined && input.files !== undefined)
        throw new Error("Use paths only, not both paths and files");
    const paths = input.paths ?? input.files;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20)
        throw new Error("browser_file_upload requires paths: [absolute workspace file paths]. Missing paths never cancels the chooser; use cancel:true explicitly to cancel.");
    return { paths: paths.map((p) => uploadFile(root, p).path) };
}
