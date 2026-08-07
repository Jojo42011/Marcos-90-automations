"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FunnelStage = void 0;
/**
 * Funnel stages and state transitions.
 * Pipeline uses this to decide which modules run.
 */
var FunnelStage;
(function (FunnelStage) {
    FunnelStage["New"] = "new";
    /**
     * Narrowed by the opener collapse (Aug 2026). It used to mean "step 1 of the
     * ladder sent (thanks + first-time buyer question), waiting for the reply
     * before the breakdown could even be offered" — a pacing beat.
     *
     * It now means only: a pinned CLARIFYING question is outstanding and no number
     * has been asked for yet. The three pinned paths that still land here all ask
     * something you genuinely cannot bolt a number request onto — the wave-only
     * reply, the "buying of what?" confusion recovery, and Marco's own manually
     * sent opener. Every pinned path whose reply is an OFFER (price, city) now
     * carries the number ask and goes straight to PhoneRequested instead.
     *
     * Leads persisted here before the collapse still deserialize and advance to
     * PhoneRequested on their next inbound rather than waiting for a beat that no
     * longer exists.
     */
    FunnelStage["OpeningAskedFirstTime"] = "opening_asked_first_time";
    /**
     * LEGACY — nothing enters this stage except the has-an-agent objection hold.
     * Was: step 2 of the ladder sent (details + other options pitch), waiting for
     * permission before the number could be asked for.
     */
    FunnelStage["OpeningOfferedDetails"] = "opening_offered_details";
    FunnelStage["IdentityRequested"] = "identity_requested";
    FunnelStage["PhoneRequested"] = "phone_requested";
    FunnelStage["PhoneCaptured"] = "phone_captured";
    FunnelStage["PropertySent"] = "property_sent";
    FunnelStage["CriteriaCollected"] = "criteria_collected";
    FunnelStage["EmailSent"] = "email_sent";
    FunnelStage["FollowUpDue"] = "follow_up_due";
    FunnelStage["FlagForCall"] = "flag_for_call";
    FunnelStage["Closed"] = "closed";
})(FunnelStage || (exports.FunnelStage = FunnelStage = {}));
