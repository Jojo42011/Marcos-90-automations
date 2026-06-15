"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeNewLead = routeNewLead;
const db_js_1 = require("../../core/db.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const index_js_2 = require("../mojoOutreach/index.js");
const MARCO_NUMBER = process.env.MARCO_PHONE_NUMBER?.trim();
function normalizeSource(source) {
    return (source ?? "").trim().toLowerCase();
}
/**
 * Routes a newly-created or newly-phone-captured lead based on its source.
 */
async function routeNewLead(lead) {
    const source = normalizeSource(lead.source);
    switch (source) {
        case "mojo":
            await routeMojoLead(lead);
            break;
        case "instagram":
        case "tiktok":
            await routeSocialDmLead(lead);
            break;
        case "web_form":
            await routeWebFormLead(lead);
            break;
        case "referral":
            await routeReferralLead(lead);
            break;
        default:
            console.log("[SourceRouting] No specific routing for source:", lead.source, "- lead", lead.id);
    }
}
async function routeMojoLead(lead) {
    if (!lead.phone?.trim())
        return;
    if ((0, index_js_2.isMojoLead)(lead) && lead.mojoOutreach?.textsSent && lead.mojoOutreach.textsSent > 0) {
        console.log("[SourceRouting] Mojo lead", lead.id, "— outreach sequence already active, skipping instant text");
        return;
    }
    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const message = `Hi ${firstName}, this is Marco — thanks for your interest! I'll have some info for you shortly. Feel free to reply with any questions in the meantime.`;
    const result = await (0, index_js_1.sendTwilioMessage)(lead.phone, message);
    if (result.success) {
        (0, smsStore_js_1.logSmsMessage)({
            leadId: lead.id,
            messageBody: message,
            direction: "outbound",
            sentAt: new Date().toISOString(),
            threadType: "source_routing",
        });
        console.log("[SourceRouting] Mojo lead", lead.id, "instant-texted");
    }
    console.log("[SourceRouting] Mojo lead", lead.id, "— email portion NOT sent (email agent gap, see Background Q6)");
}
async function routeSocialDmLead(lead) {
    console.log("[SourceRouting] Social DM lead", lead.id, "— routes through existing pipeline (no new action needed)");
}
async function routeWebFormLead(lead) {
    if (!lead.phone?.trim())
        return;
    console.log("[SourceRouting] Web form lead", lead.id, "— no web form intake exists yet; 2-min auto-response scheduled when intake is built");
    setTimeout(async () => {
        const refreshed = await Promise.resolve().then(() => __importStar(require("../../core/db.js"))).then((m) => m.getLeadById(lead.id));
        if (!refreshed?.phone?.trim())
            return;
        const firstName = refreshed.name?.trim().split(/\s+/)[0] || "there";
        const message = `Hi ${firstName}, thanks for reaching out through our website! This is Marco's team — happy to help with anything you need. What can I help you with?`;
        const result = await (0, index_js_1.sendTwilioMessage)(refreshed.phone, message);
        if (result.success) {
            (0, smsStore_js_1.logSmsMessage)({
                leadId: refreshed.id,
                messageBody: message,
                direction: "outbound",
                sentAt: new Date().toISOString(),
                threadType: "source_routing",
            });
            console.log("[SourceRouting] Web form lead", refreshed.id, "auto-responded after 2min");
        }
    }, 2 * 60 * 1000);
}
async function routeReferralLead(lead) {
    await (0, db_js_1.updateLeadCrmFields)({
        leadId: lead.id,
        crmPriority: "high",
    });
    if (MARCO_NUMBER) {
        const message = `⭐ REFERRAL LEAD: ${lead.name || lead.username || "New lead"} (${lead.phone || "no phone"}). Flagged high priority — personal call recommended.`;
        await (0, index_js_1.sendTwilioMessage)(MARCO_NUMBER, message);
        console.log("[SourceRouting] Referral lead", lead.id, "— Marco notified, flagged high priority");
    }
}
