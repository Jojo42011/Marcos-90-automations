# Single Dialer Smart Queues — Design

Approved 2026-11-09 (America/Chicago). Approach 1: server-side smart queues in shell Dialer; remove in-CRM Dialer entirely.

## 1. Product shape

- **Keep:** shell Dialer tab only (`/dialer`, `/api/dialer/*`).
- **Remove:** CRM rail Dialer button, `#view-followup` markup, `renderFollowUp` / dial-* JS, CRM-only `growth-dialer.css` coupling, verify asserts that require the CRM Dialer UI.
- **Redirect:** CRM `?view=followup` / `data-view="followup"` → shell Dialer with optional `?queue=…` (via `app-navigate` when embedded, else `/dialer?queue=…`).
- **Smart queues** (same meaning as former CRM Dialer):

| Queue id | Rule |
| --- | --- |
| `due` | `crmCallQueue === "urgent"` (former Due today) |
| `mojo` | Mojo / Mojo FL source + Expired/Canceled tags or expired source |
| `new` | CRM status maps to display status `new` |
| `nurture` | CRM status maps to display status `nurture` |
| `everyone` | Has phone, not DNC (callable set) |

- **Session model:** Starting a session from a smart queue uses the same session/outcome/outbox/Tracker bump path as list sessions. Calls remain manual `tel:` / Quo phone app — no automatic dialing.
- **UX:** Queues as first-class Dialer nav with live counts and honest empty states; Quo line picker on session start; + Add contact; Open CRM profile deep-link; CSV import unchanged.

## 2. API / data

- Enrich Dialer `Contact` projection during CRM sync with: `tags[]`, `crmStatus`, `crmCallQueue` (preserve existing fields).
- Pure helpers: `statusDisp(crmStatus)`, `isMojoExpired(contact)`, `matchesQueue(contact, queueId)`.
- `GET /api/dialer/queues` → `{ queues: [{ id, label, count, description }] }` for the signed-in actor’s visible contacts.
- `GET /api/dialer/contacts?queue=<id>` → filter contacts by smart queue (alongside existing `listId` / `q` / `assignedTo`).
- `POST /api/dialer/sessions` accepts `queueId` **or** `listId` **or** `contactIds` (existing). Session records store `queueId` when used; `listId` may be empty.
- `POST /api/dialer/contacts` creates one contact (name, phone, optional source/tags/intent/side) into the Dialer store with quiet CRM create + optional Tracker side — replaces CRM Dialer “+ Add lead”.
- Guide/overview document queues. Harvey discovers the same routes via existing dialer surface.

## 3. CRM deletion checklist

- Remove Dialer rail button and `#view-followup` section from `public/crm-brivity.html`.
- Remove Dialer CSS include of `growth-dialer.css` if unused elsewhere; keep file only if other pages need it (prefer delete if Dialer-only).
- Strip `DIAL*` / `renderFollowUp` / dial binders; keep unrelated `crmCallQueue` lead fields (Overview/tasks still use urgent).
- Deep-link handler: `followup` → navigate to Dialer tab / `/dialer`.
- Update `scripts/verify-crm-command-center.mjs` (no CRM Dialer UI required; assert redirect/absence instead).
- Extend `scripts/verify-dialer-workspace.mjs` for queue enrichment, queue listing, session-from-queue, add-contact.
- Update `FORAI.md` Recent changes + limits note: single Dialer with smart queues; CRM Dialer removed.

## Out of scope

- Quo click-to-call / power dialer
- Homeowner enrichment
- Merging Reporting/Finance/Nurture dual pages
- Message Center Quo/Twilio fix
