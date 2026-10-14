"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.atomicJson = atomicJson;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
/** Publish a complete file in the same filesystem. Failures before rename leave the original intact. */
function atomicJson(path, value) {
    const text = JSON.stringify(value);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    const temporary = `${path}.${(0, node_crypto_1.randomUUID)()}.pending`;
    let fd;
    try {
        fd = (0, node_fs_1.openSync)(temporary, "wx", 0o600);
        (0, node_fs_1.writeFileSync)(fd, text, "utf8");
        (0, node_fs_1.fsyncSync)(fd);
        (0, node_fs_1.closeSync)(fd);
        fd = undefined;
        (0, node_fs_1.renameSync)(temporary, path);
        // Directory fsync makes the rename durable on filesystems which support it.
        // Publication has already happened: a platform-specific sync error must not roll memory back.
        let directory;
        try {
            directory = (0, node_fs_1.openSync)((0, node_path_1.dirname)(path), "r");
            (0, node_fs_1.fsyncSync)(directory);
        }
        catch (error) {
            if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code || ""))
                console.error("[storage] directory sync failed", error);
        }
        finally {
            if (directory !== undefined) {
                try {
                    (0, node_fs_1.closeSync)(directory);
                }
                catch (error) {
                    console.error("[storage] directory close failed", error);
                }
            }
        }
    }
    finally {
        if (fd !== undefined)
            (0, node_fs_1.closeSync)(fd);
        try {
            (0, node_fs_1.unlinkSync)(temporary);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                console.error("[storage] temporary cleanup failed", error);
        }
    }
}
