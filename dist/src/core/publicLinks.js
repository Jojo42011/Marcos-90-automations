"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicResource = publicResource;
exports.publicLink = publicLink;
exports.verifyPublicLink = verifyPublicLink;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tenantData_js_1 = require("./tenantData.js");
function publicResource(path) {
    return /^\/r\/(open|click|stop|report)$/.test(path) || /^\/c\/[^/]+$/.test(path);
}
function keyPath(owner) {
    if ((0, tenantData_js_1.tenantOwner)()) {
        if (owner !== (0, tenantData_js_1.tenantOwner)())
            throw new Error("Public link account mismatch");
        return (0, tenantData_js_1.dataPath)("public-link.key");
    }
    return owner ? (0, node_path_1.join)((0, tenantData_js_1.dataPath)(), "accounts", (0, node_crypto_1.createHash)("sha256").update(owner).digest("hex"), "public-link.key") : (0, tenantData_js_1.dataPath)("public-link.key");
}
function canonical(url) {
    const copy = new URL(url);
    copy.searchParams.delete("signature");
    copy.searchParams.sort();
    return copy.pathname + copy.search;
}
/** A capability covers exactly one route and its parameters, with no account session. */
function publicLink(path) {
    const url = new URL(path, "http://public.local");
    if (!publicResource(url.pathname))
        throw new Error("Unsupported public resource");
    const owner = (0, tenantData_js_1.tenantOwner)();
    if (process.env.ACCOUNT_ISOLATION !== "true")
        return path;
    const file = keyPath(owner);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(file), { recursive: true });
    if (!(0, node_fs_1.existsSync)(file)) {
        try {
            (0, node_fs_1.writeFileSync)(file, (0, node_crypto_1.randomBytes)(32).toString("hex"), { flag: "wx", mode: 0o600 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    url.searchParams.set("owner", owner);
    url.searchParams.set("signature", (0, node_crypto_1.createHmac)("sha256", (0, node_fs_1.readFileSync)(file)).update(canonical(url)).digest("hex"));
    return url.pathname + url.search;
}
function verifyPublicLink(path) {
    try {
        const url = new URL(path, "http://public.local");
        if (!publicResource(url.pathname))
            return;
        const owner = url.searchParams.get("owner");
        const signature = url.searchParams.get("signature") || "";
        if (owner === null || !/^[a-f0-9]{64}$/.test(signature))
            return;
        const expected = (0, node_crypto_1.createHmac)("sha256", (0, node_fs_1.readFileSync)(keyPath(owner))).update(canonical(url)).digest();
        if ((0, node_crypto_1.timingSafeEqual)(expected, Buffer.from(signature, "hex")))
            return owner;
    }
    catch { /* Invalid capabilities never fall back to authenticated account routing. */ }
}
