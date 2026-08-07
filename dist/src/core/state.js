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
     * LEGACY — no new lead enters this stage since the opener was collapsed
     * (Aug 2026). Kept because live leads were sitting here when the change
     * shipped and their persisted state must still deserialize; they advance
     * straight to PhoneRequested on their next inbound.
     *
     * It used to mean: step 1 sent (thanks + first-time buyer question),
     * waiting for the reply before the breakdown could even be offered.
     */
    FunnelStage["OpeningAskedFirstTime"] = "opening_asked_first_time";
    /** LEGACY — see above. Was: step 2 sent (details + other options pitch). */
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
