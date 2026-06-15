"use strict";
/**
 * Harvey judgment — ops focus areas and actionable directives from context.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJudgment = runJudgment;
function fmtMoney(n) {
    if (n == null || !Number.isFinite(n))
        return "—";
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function runJudgment(ctx, operatorMessage) {
    const focus = [];
    const directives = [];
    const msg = operatorMessage.toLowerCase();
    const hotSms = ctx.hotLeads.filter((l) => l.hasPhone && (l.crmStatus === "not_contacted" || l.crmStatus === "contacted"));
    const phones24 = ctx.totals.phonesLast24h;
    const noInteraction = ctx.noInteractionLeads.length;
    const stalled = ctx.stalledOpeningLeads.length;
    const cpl = ctx.ads.cpl;
    const spend = ctx.ads.spend;
    if (phones24 > 0) {
        focus.push("new_phone_captures");
        directives.push({
            severity: "warn",
            text: `${phones24} phone${phones24 === 1 ? "" : "s"} captured in the last 24h — confirm SMS breakdown queued (Twilio inbound-first).`,
        });
    }
    if (hotSms.length > 0) {
        focus.push("hot_leads_sms");
        const names = hotSms
            .slice(0, 3)
            .map((l) => l.name || l.username || l.phone || "lead")
            .join(", ");
        directives.push({
            severity: "danger",
            text: `${hotSms.length} hot lead${hotSms.length === 1 ? "" : "s"} with phone on file, not fully worked — ${names}${hotSms.length > 3 ? "…" : ""}.`,
        });
    }
    if (noInteraction > 0) {
        focus.push("no_interaction");
        directives.push({
            severity: "warn",
            text: `${noInteraction} lead${noInteraction === 1 ? "" : "s"} need first touch or long idle follow-up.`,
        });
    }
    if (stalled > 0) {
        focus.push("stalled_dm_funnel");
        const igStalled = ctx.stalledOpeningLeads.filter((l) => l.platform.toLowerCase().includes("insta")).length;
        const ttStalled = ctx.stalledOpeningLeads.filter((l) => l.platform.toLowerCase().includes("tik")).length;
        directives.push({
            severity: "warn",
            text: `${stalled} lead${stalled === 1 ? "" : "s"} stuck in opening funnel 48h+ (IG ${igStalled}, TikTok ${ttStalled}) — check DM thread.`,
        });
    }
    if (ctx.callQueue.urgent > 0) {
        focus.push("call_queue");
        directives.push({
            severity: "danger",
            text: `${ctx.callQueue.urgent} lead${ctx.callQueue.urgent === 1 ? "" : "s"} in urgent call queue — Marco line 210-801-2380.`,
        });
    }
    if (ctx.ads.configured && cpl != null && cpl > 25) {
        focus.push("ad_performance");
        directives.push({
            severity: "warn",
            text: `Meta CPL ${fmtMoney(cpl)} on ${spend != null ? fmtMoney(spend) : "current"} spend — review Canyon Lake vs low-interest creative.`,
        });
    }
    else if (ctx.ads.configured && ctx.ads.adLeads != null && ctx.ads.adLeads > 0) {
        focus.push("ad_performance");
        directives.push({
            severity: "info",
            text: `Ads: ${ctx.ads.adLeads} platform lead${ctx.ads.adLeads === 1 ? "" : "s"}, CPL ${cpl != null ? fmtMoney(cpl) : "n/a"} — ${ctx.byAdCampaign.canyon_lake_ad} Canyon / ${ctx.byAdCampaign.low_interest_ad} low-rate attributed in DM.`,
        });
    }
    if (ctx.byPlatform.tiktok > ctx.byPlatform.instagram && ctx.totals.allLeads >= 5) {
        focus.push("platform_mix");
        directives.push({
            severity: "info",
            text: `TikTok ${ctx.byPlatform.tiktok} vs Instagram ${ctx.byPlatform.instagram} leads — TikTok usually converts faster; prioritize TT hot phones.`,
        });
    }
    if (ctx.byAdCampaign.canyon_lake_ad > 0) {
        directives.push({
            severity: "info",
            text: `Canyon Lake ad: ${ctx.byAdCampaign.canyon_lake_ad} tagged (${ctx.byAdCampaign.canyonWithPhone} with phone) — $365k 3/2 showing/call close.`,
        });
    }
    if (ctx.byAdCampaign.low_interest_ad > 0) {
        directives.push({
            severity: "info",
            text: `Low interest ad: ${ctx.byAdCampaign.low_interest_ad} tagged (${ctx.byAdCampaign.lowInterestWithPhone} with phone) — financing-angle buyers.`,
        });
    }
    if (!ctx.systems.twilioConfigured) {
        directives.push({
            severity: "danger",
            text: "Twilio not configured — SMS handoff from CRM will fail until TWILIO_* env is set.",
        });
    }
    if (!ctx.systems.anthropicConfigured) {
        directives.push({
            severity: "danger",
            text: "DM AI offline (no ANTHROPIC_API_KEY) — Instagram/TikTok automations on template fallbacks only.",
        });
    }
    if (directives.length === 0) {
        focus.push("steady_state");
        directives.push({
            severity: "info",
            text: `Pipeline steady — ${ctx.totals.allLeads} leads, ${ctx.totals.withPhone} phones (${ctx.totals.phoneCaptureRatePct}% capture). Nothing urgent flagged.`,
        });
    }
    const briefingSeed = [
        `${ctx.totals.allLeads} leads, ${ctx.totals.withPhone} phones (${ctx.totals.phoneCaptureRatePct}% capture).`,
        `IG ${ctx.byPlatform.instagram} / TT ${ctx.byPlatform.tiktok}.`,
        `Hot ${hotSms.length}, idle ${noInteraction}, stalled opening ${stalled}.`,
        msg.includes("ad") || msg.includes("cpl") ? `Ads CPL ${cpl != null ? fmtMoney(cpl) : "n/a"}.` : "",
    ]
        .filter(Boolean)
        .join(" ");
    return {
        focus: focus.length ? focus : ["steady_state"],
        directives: directives.slice(0, 5),
        briefingSeed,
    };
}
