"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountIntegrationEnvironment = accountIntegrationEnvironment;
exports.integrationStatus = integrationStatus;
exports.saveIntegrationSettings = saveIntegrationSettings;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const atomicJson_js_1 = require("./atomicJson.js");
const tenantData_js_1 = require("./tenantData.js");
// Explicit provider settings only. No executable, filesystem, identity, or tenant overrides.
const ALLOWED = new Set([
    "MOJO_WEBHOOK_SECRET", "WEBSITE_WEBHOOK_SECRET",
    "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_FROM", "GMAIL_USER",
    "GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD", "GMAIL_SMTP_HOST", "GMAIL_SMTP_PORT", "GMAIL_SMTP_DAILY_CAP", "GMAIL_FROM_NAME",
    "BRIVITY_API_KEY", "BRIVITY_BASE_URL", "QUO_API_KEY", "QUO_PHONE_NUMBER_ID", "QUO_PHONE_NUMBER",
    "TWILIO_WEBHOOK_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_WHATSAPP_FROM",
    "SINCH_SERVICE_PLAN_ID", "SINCH_API_TOKEN", "SINCH_FROM_NUMBER"
]);
function file(owner) { return (0, node_path_1.join)((0, tenantData_js_1.dataPath)(), "accounts", (0, node_crypto_1.createHash)("sha256").update(owner).digest("hex"), "integration-settings.json"); }
function accountIntegrationEnvironment(owner) {
    if (!(0, node_fs_1.existsSync)(file(owner)))
        return {};
    const raw = JSON.parse((0, node_fs_1.readFileSync)(file(owner), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid account integration settings");
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => ALLOWED.has(key) && typeof value === "string"));
}
function integrationStatus(owner) {
    const current = accountIntegrationEnvironment(owner);
    return Object.fromEntries([...ALLOWED].map(key => [key, Boolean(current[key])]));
}
function saveIntegrationSettings(owner, values) {
    if (!values || typeof values !== "object" || Array.isArray(values))
        throw new Error("Expected integration settings object");
    const next = accountIntegrationEnvironment(owner);
    for (const [key, value] of Object.entries(values)) {
        if (!ALLOWED.has(key) || typeof value !== "string" || value.length > 16384)
            throw new Error("Unsupported integration setting");
        if (value.trim())
            next[key] = value.trim();
        else
            delete next[key];
    }
    (0, atomicJson_js_1.atomicJson)(file(owner), next);
}
