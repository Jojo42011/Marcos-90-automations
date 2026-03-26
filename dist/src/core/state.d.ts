/**
 * Funnel stages and state transitions.
 * Pipeline uses this to decide which modules run.
 */
export declare enum FunnelStage {
    New = "new",
    /** Step 1 sent: thanks + first-time buyer question; waiting for lead reply. */
    OpeningAskedFirstTime = "opening_asked_first_time",
    /** Step 2 sent: details + other options pitch; waiting for lead to agree. */
    OpeningOfferedDetails = "opening_offered_details",
    IdentityRequested = "identity_requested",
    PhoneRequested = "phone_requested",
    PhoneCaptured = "phone_captured",
    PropertySent = "property_sent",
    CriteriaCollected = "criteria_collected",
    EmailSent = "email_sent",
    FollowUpDue = "follow_up_due",
    FlagForCall = "flag_for_call",
    Closed = "closed"
}
//# sourceMappingURL=state.d.ts.map