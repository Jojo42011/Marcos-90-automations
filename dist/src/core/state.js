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
    /** Ambiguous first message: asked for a screenshot of the home so we know which listing. */
    FunnelStage["ListingClarificationRequested"] = "listing_clarification_requested";
    /** Step 1 sent: thanks + first-time buyer question; waiting for lead reply. */
    FunnelStage["OpeningAskedFirstTime"] = "opening_asked_first_time";
    /** Step 2 sent: details + other options pitch; waiting for lead to agree. */
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
