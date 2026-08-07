# Telling the DM agent which house the lead is asking about

**Status:** the code side is live. The ManyChat side is a per-flow change someone
has to make in the ManyChat UI — nothing happens until then, and nothing breaks
if it never happens.

## The problem this solves

Until now the DM agent opened every thread blind. A lead messages from a TikTok
video of a specific home and the agent has no idea which one — so it cannot
answer "is it still available?", "how many bedrooms?", or "what's the lot like?"
without either asking which property they mean or guessing. Asking costs a round
trip, and the gaps between DM turns run days.

ManyChat already knows. The flow fired from one specific post. It just was not
passing that along.

## What to change in ManyChat

In the External Request step that calls the webhook, add one field to the JSON
body:

```json
{
  "platform": "tiktok",
  "user_id": "...",
  "message": "...",
  "listing_id": "1799432"
}
```

`listing_id` accepts **either** the MLS number or the internal listing key —
whichever is easier to get into the field. These aliases are also accepted, so
use whichever name your flow already has: `listingId`, `listing_key`,
`listingKey`, `mls_number`, `mlsNumber`, `mls`, `property_id`, `propertyId`.

Set it per flow, so the value matches the post that flow is attached to. A
ManyChat custom field per campaign is the usual way.

## What happens with the value

1. It is looked up against the MLS mirror.
2. **If it resolves**, the lead is linked to that listing (`mlsListingKey`), and
   the agent is told the address and specs, with an explicit instruction never to
   ask which property they mean or to ask for a screenshot.
3. **If it does not resolve**, it is logged and dropped. Nothing is stored.
4. **If the lead is already linked** to a different listing, the new value is
   logged as a conflict and the existing link is left alone.

Point 3 is deliberate: a stale, mistyped, or Zillow id becoming a link would be
worse than no link at all, because the matcher, the drip campaigns, and the
client property PDF all key off `mlsListingKey` and would confidently send a real
lead the wrong house.

Point 4 is also deliberate. Marco or Carlos can set that link by hand from the
CRM ("Set as their property"). A later automation firing should not silently
retarget a lead someone deliberately linked.

## What it does NOT change

Knowing the price does not mean quoting it. The no-list-price-in-DM rule for
TikTok and Instagram DMs still applies in full — the breakdown-by-text is what
carries pricing, and that is exactly why it earns the phone number.

## Checking it works

Every inbound with a listing value logs `inbound_listing_ref` with the outcome
(`resolved` / `unresolved` / `already_linked` / `conflict`), what was sent, and
what it resolved to. An inbound with no value logs nothing, because that is the
ordinary case. If a flow looks wired but leads are not linking, search the logs
for `unresolved` — that means ManyChat is sending something the MLS mirror does
not recognize.
