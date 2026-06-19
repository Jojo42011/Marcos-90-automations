"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onLeadEmailCaptured = onLeadEmailCaptured;
const buyerDrip_js_1 = require("./buyerDrip.js");
const sellerDrip_js_1 = require("./sellerDrip.js");
const autoReply_js_1 = require("./autoReply.js");
/** Fire email marketing automations when a lead gains an email address. */
function onLeadEmailCaptured(lead) {
    if (!lead.email?.trim())
        return;
    (0, autoReply_js_1.scheduleAutoReply)(lead);
    if (lead.crmIntent === "seller") {
        (0, sellerDrip_js_1.startSellerDrip)(lead.id);
    }
    else if (lead.crmIntent === "buyer" || lead.crmIntent === "buyer_seller") {
        (0, buyerDrip_js_1.startBuyerDrip)(lead.id);
    }
    else {
        console.log("[EmailMarketing] Lead", lead.id, "— crmIntent unknown, drip not auto-started");
    }
}
