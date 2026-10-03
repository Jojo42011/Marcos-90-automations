"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverMarcoCrm = recoverMarcoCrm;
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
/** Restore the original operator's CRM only before its isolated worker starts.
 * Never replace an existing account store, or import task ownership implicitly. */
function recoverMarcoCrm(root, target, explicitSource) {
    if (["db.json", "local-dashboard-db.json"].some(f => (0, fs_1.existsSync)((0, path_1.join)(target, f))))
        return;
    const source = explicitSource || ["db.json", "local-dashboard-db.json"].map(f => (0, path_1.join)(root, f)).find(fs_1.existsSync);
    if (!source || !(0, fs_1.existsSync)(source))
        return;
    const raw = (0, fs_1.readFileSync)(source, "utf8"), data = JSON.parse(raw);
    if (!data.leadsById || !Object.keys(data.leadsById).length)
        return;
    if (typeof data.leadsById !== "object" || Array.isArray(data.leadsById))
        throw new Error("Invalid retained CRM store");
    const digest = (0, crypto_1.createHash)("sha256").update(raw).digest("hex");
    const backup = (0, path_1.join)(root, "crm-recovery-backups");
    (0, fs_1.mkdirSync)(backup, { recursive: true });
    const backupFile = (0, path_1.join)(backup, digest + ".json");
    if (!(0, fs_1.existsSync)(backupFile))
        (0, fs_1.writeFileSync)(backupFile, raw, { flag: "wx", mode: 0o600 });
    if ((0, fs_1.readFileSync)(backupFile, "utf8") !== raw)
        throw new Error("CRM recovery backup verification failed");
    (0, fs_1.mkdirSync)(target, { recursive: true });
    const restored = { idCounter: data.idCounter, leadsById: data.leadsById, leadKeyToId: data.leadKeyToId || {}, conversationsByLeadId: data.conversationsByLeadId || {}, commandTasks: [] };
    const pending = (0, path_1.join)(target, "crm-recovery-" + digest + ".pending");
    if (!(0, fs_1.existsSync)(pending))
        (0, fs_1.writeFileSync)(pending, JSON.stringify(restored), { flag: "wx", mode: 0o600 });
    if ((0, fs_1.readFileSync)(pending, "utf8") !== JSON.stringify(restored))
        throw new Error("CRM recovery staging verification failed");
    // Atomic publication without overwriting a file created concurrently.
    (0, fs_1.linkSync)(pending, (0, path_1.join)(target, "db.json"));
    (0, fs_1.unlinkSync)(pending);
    (0, fs_1.writeFileSync)((0, path_1.join)(target, "crm-recovery-receipt.json"), JSON.stringify({ sourceDigest: digest, leads: Object.keys(data.leadsById).length, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    console.log("[crm-recovery] Restored original CRM to Marco workspace", Object.keys(data.leadsById).length);
}
