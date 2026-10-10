"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueAccountBridge = issueAccountBridge;
exports.accountBridgeToken = accountBridgeToken;
exports.accountBridgeUser = accountBridgeUser;
exports.accountBridgeFetch = accountBridgeFetch;
const crypto_1 = require("crypto");
const users_js_1 = require("./users.js");
const workspaceAccess_js_1 = require("./workspaceAccess.js");
const tokens = new Map();
let gatewayUrl = "", childToken = "";
function issueAccountBridge(owner) { const token = (0, crypto_1.randomBytes)(32).toString("hex"); tokens.set(owner, token); return token; }
function accountBridgeToken(owner) { return tokens.get(owner); }
process.on("message", (message) => {
    if (process.env.TENANT_OWNER_ID && message?.type === "account-bridge") {
        childToken = message.token;
        gatewayUrl = message.url;
        tokens.set(process.env.TENANT_OWNER_ID, childToken);
    }
});
function accountBridgeUser(req) {
    const address = req.socket?.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address))
        return null;
    const value = req.headers["x-account-bridge"];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        return null;
    for (const [owner, token] of tokens)
        if ((0, crypto_1.timingSafeEqual)(Buffer.from(value), Buffer.from(token))) {
            const forwarded = process.env.TENANT_OWNER_ID && req.headers["x-account-actor"];
            const user = (0, users_js_1.getAccountUserById)(typeof forwarded === "string" ? forwarded : owner);
            return user?.active && !user.mustChangePassword && (0, workspaceAccess_js_1.canViewWorkspace)(user, owner) ? user : null;
        }
    return null;
}
async function accountBridgeFetch(path, options = {}) {
    if (!gatewayUrl || !childToken)
        throw new Error("Team CRM bridge is not ready");
    if (!path.startsWith("/api/") || path.startsWith("//"))
        throw new Error("Invalid CRM path");
    return fetch(gatewayUrl + path, { ...options, redirect: "error", headers: { ...options.headers, "x-account-bridge": childToken } });
}
