/**
 * Funnel stages and state transitions.
 * Pipeline uses this to decide which modules run.
 */
export enum FunnelStage {
  New = "new",
  /**
   * LEGACY — no new lead enters this stage since the opener was collapsed
   * (Aug 2026). Kept because live leads were sitting here when the change
   * shipped and their persisted state must still deserialize; they advance
   * straight to PhoneRequested on their next inbound.
   *
   * It used to mean: step 1 sent (thanks + first-time buyer question),
   * waiting for the reply before the breakdown could even be offered.
   */
  OpeningAskedFirstTime = "opening_asked_first_time",
  /** LEGACY — see above. Was: step 2 sent (details + other options pitch). */
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

