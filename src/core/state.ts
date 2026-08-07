/**
 * Funnel stages and state transitions.
 * Pipeline uses this to decide which modules run.
 */
export enum FunnelStage {
  New = "new",
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
  OpeningAskedFirstTime = "opening_asked_first_time",
  /**
   * LEGACY — nothing enters this stage except the has-an-agent objection hold.
   * Was: step 2 of the ladder sent (details + other options pitch), waiting for
   * permission before the number could be asked for.
   */
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

