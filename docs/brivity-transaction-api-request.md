# Request to Brivity: transaction API access

Draft for Marco to send to Brivity support (support@brivity.com) or his account
manager. The technical detail is deliberately specific — a vague "do you have an
API?" gets a link to the same docs we already read.

Keep the API key out of the message. Nothing below contains one.

---

**Subject:** API access to transaction data — existing Core API key only returns People

Hi,

I'm Marco Puga (Brivity account for Marco Puga Real Estate). We use the Brivity
Core API to keep our own operations dashboard in sync, and today it works well
for contacts — `GET https://api.brivity.com/api/people` with our
`Authorization: Token token=…` key returns our full roster, around 2,600 people,
and we pull it on a schedule.

What we're missing is transactions. We'd like our dashboard to show live
pipeline: what's under contract, what's active, what closed this year, and the
GCI on closed deals. Right now we have to export a report from the Brivity web
app and upload the CSV by hand, which means the numbers on our dashboard are
only as fresh as the last time someone remembered to do it.

Before writing in I checked what our key can reach. `/api/people` authenticates
normally (401 "Bad Credentials" without a key, data with one). Every other path
I tried — `/api/transactions`, `/api/deals`, `/api/listings`, `/api/escrows`,
`/api/closings`, and the `/api/v2/*` equivalents — returns a generic
`406 Not Acceptable`, and so does a deliberately made-up path, so I take it
those endpoints simply aren't part of the surface this key is scoped to.

Three questions:

1. **Is there a transaction/pipeline endpoint on the Core API**, on a different
   base URL, version prefix, or scope than `/api/people`? If our key just needs
   an added scope, that would be the ideal answer.
2. **If not, are webhooks available** for transaction created / status changed /
   closed? Push would suit us better than polling, and we can stand up an HTTPS
   endpoint to receive them.
3. **If neither exists today**, is there a partner or enterprise API tier that
   includes transactions, and what does it take to get on it?

The fields we need per transaction are modest: property address, transaction
side (buyer/seller/dual), status, MLS number, assigned agent, list price, sale
price, gross commission, list date, contract/mutual-acceptance date, and close
date. That is the same set your transaction report export already contains, so
if there's an endpoint that returns that report as JSON, that alone solves it.

Happy to jump on a call or share more about the integration if it helps.

Thanks,
Marco Puga

---

## For whoever handles the reply

- **If they grant an endpoint or a scope:** the work is a new
  `src/core/brivityTransactions.ts` modelled on `brivityPeople.ts` (same auth
  header, same cache-and-serve-stale-on-error shape), plus a scheduled pull. The
  mapping into our `Transaction` shape already exists in
  `src/core/transactionImport.ts` — only the fetch and the field names change.
  At that point the "as of <import date>" labels in the CRM and on the tracker
  Funnel snapshot become "live", and `GET /api/transactions/import-status`
  should start returning `live: true`.
- **If they offer webhooks:** we need a public receiver route plus a shared
  secret; the same mapping applies per event.
- **If the answer is no:** the CSV import is the supported path and stays. It is
  already wired end to end — CRM → Transactions → **Import CSV** — and it dry-runs
  before it writes.
