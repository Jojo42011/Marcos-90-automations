/**
 * Funnel stages and state transitions.
 * Pipeline uses this to decide which modules run.
 */
export enum FunnelStage {
  New = "new",
  /** Ambiguous first message: asked for a screenshot of the home so we know which listing. */
  ListingClarificationRequested = "listing_clarification_requested",
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
  Closed = "closed",
}

