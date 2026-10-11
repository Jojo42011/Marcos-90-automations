"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNT_INBOUND = void 0;
exports.accountInboundPath = accountInboundPath;
exports.ACCOUNT_INBOUND = { quo: "/api/quo/webhook", mojo: "/api/mojo/webhook", website: "/api/website/lead", twilio: "/webhook/twilio" };
function accountInboundPath(provider) {
    const route = exports.ACCOUNT_INBOUND[provider];
    if (!route)
        throw new Error("Unsupported inbound provider");
    return process.env.TENANT_OWNER_ID ? `/api/account-inbound/${encodeURIComponent(process.env.TENANT_OWNER_ID)}/${provider}` : route;
}
