# Marco 90% Automation

**Your pipeline, on autopilot.**

A fully custom-coded automation system built for **Marco Puga**, a San Antonio real estate agent. This project eliminates every manual step in his buyer lead pipeline — from the first TikTok or Instagram comment to the email in the lead’s inbox — so Marco’s only job is closing.

---

## The Problem

Marco currently handles his entire buyer lead workflow by hand:

- **Monitoring** TikTok and Instagram comments for buyer intent  
- **DMing** leads and qualifying them  
- **Collecting** phone numbers and emails  
- **Searching** for matching properties  
- **Entering** leads into his CRM (Brivity)  
- **Following up** the next day  

That takes **3–4 hours of admin per day**. Leads go cold while he’s typing, and manual bottlenecks (e.g. 14+ leads not yet in the CRM) make it hard to scale. The system we’re building removes every one of those manual steps so every lead gets an instant, consistent response 24/7.

---

## What This Project Is

This is a **custom automation system** — no GoHighLevel templates, no generic flows. Everything is built in code, tailored to how Marco actually works, and owned by him. Each module maps to a real step we observed in his workflow.

**Overall goal:** Free Marco from admin entirely so his only job is closing. When a lead specifically needs his closer skills, the system flags him; otherwise, the pipeline runs without him touching it.

---

## The 12 Automation Modules

Every module below corresponds to a step in Marco’s current manual process. Each one is designed to replicate his tone, his rules, and his goals (e.g. phone capture in 2 messages).

| # | Module | What it does |
|---|--------|----------------|
| **01** | **Comment & DM Monitor** | Detects buyer intent from TikTok and Instagram comments (e.g. “How much is it?”, “Where is this located?”). Flags these without Marco manually checking activity tabs. |
| **02** | **Identity Resolution** | Tries to resolve the lead’s real name from username or profile. If it can’t, the follow-up message includes a polite name request — same as Marco does manually. |
| **03** | **Tone-Matched Opening DM** | Reads the energy of the lead’s message (short/direct vs. detailed/excited) and generates the right opening. Short messages get a plain period; excited ones get matched enthusiasm. |
| **04** | **Phone Number Extraction (2-Text Goal)** | Guides the conversation to a phone number in **2 texts or fewer**. If they ask for email first, the system pushes back the way Marco does: “For this specific property, a number is best.” Handles resistance without him typing. |
| **05** | **Property Breakdown Generator** | Builds the vague-but-valuable property breakdown automatically: specs, features, descriptive copy. No address, builder, or neighborhood. Sends it with: “Was this what you were looking for, or something in a different price range or location?” |
| **06** | **Criteria Pivot & Email Extraction** | If the original property doesn’t fit, the system pivots: “No worries — would it help if I sent over similar options in your price range?” Collects criteria (price cap, beds, baths, area) and captures email inside the same flow. |
| **07** | **New Home Buddy Search & Email** | Uses the extracted criteria to query New Home Buddy (or alternative MLS) for matching listings, builds a personalized curated email, and sends it via Gmail. Then sends a text: “Just sent them over — excited to hear what you think.” All without Marco touching anything. |
| **08** | **CRM Entry — Brivity Auto-Sync** | Every captured lead is automatically created in Brivity with full details: name, phone, email, source (TikTok/Instagram/Ads), property inquired about, buyer status, and timeline. The backlog of leads not yet entered never happens again. |
| **09** | **Brivity API Sync Fix** | Diagnoses and rebuilds the existing cold call → Brivity API sync so it pushes correctly every time. Nurture leads from the 8AM cold calling block show up reliably in Brivity with no manual cleanup. |
| **10** | **Follow-Up Sequence & Feedback Call Flag** | The day after the email goes out, the system sends a follow-up text asking for feedback. Based on the response (positive, negative, or vague), it either narrows the search automatically or **flags Marco for a personal call**. He’s only pulled in when it actually needs his closer skills. |
| **11** | **Past Client Retention Engine** | Sends weekly real estate life update emails to the full past client list. Every 3 months, triggers an Amazon gift order with a personal message and a referral ask: “Do you know anyone looking to buy or sell in 2026?” |
| **12** | **A/B DM Testing Framework** | Rotates different opening DM variants across leads, tracks which version reaches phone capture in fewer messages, and surfaces the winner automatically so Marco can double down on what works. |

---

## Before vs. After

| Without automation | With this system |
|--------------------|------------------|
| 3–4 hours daily on manual admin | Admin runs itself 24/7 |
| 12 manual steps per lead | Every lead gets an instant response |
| Leads go cold while you type | Speed to lead never drops |
| 14 leads overwhelming — 50 impossible | Handle hundreds simultaneously |
| CRM always behind | CRM always current, always clean |
| Past clients forget you exist | Referrals arriving on autopilot |

---

## Project Context

- **Prepared for:** Marco Puga  
- **Prepared by:** Jahan  
- **Location:** San Antonio, Texas  
- **Proposal date:** March 2026  

This README reflects the scope and modules defined in the automation proposal. Implementation details and setup will be documented as the system is built and deployed.

---

## ManyChat: Instagram comment automation (first touch)

For the **comment** trigger when ManyChat does not expose the comment text for new contacts, send a JSON body **without** a `message` field. The webhook creates the lead (no intent gate, no LLM) and returns a fixed handshake reply; the lead’s **first DM** to the bot should include `message` (e.g. Last Text Input) so the normal AI pipeline runs.

Example External Request body:

```json
{
  "platform": "instagram",
  "user_id": "{{Instagram Username}}",
  "username": "{{Full Name}}",
  "comment_or_dm": "comment"
}
```

DM flows should keep sending `message` and use `"comment_or_dm": "dm"` (or omit `comment_or_dm`).

---

## TikTok: Marco’s manual first DM, then AI

Marco often sends the **first TikTok DM himself** after seeing a comment. When the lead replies, ManyChat should call the webhook with:

- `message` = the lead’s latest text (e.g. Last Text Input)
- `marco_previous_outbound` = the **exact** opener Marco sent in TikTok (copy/paste or a stored snippet)

The server inserts that line as Marco’s first turn in the thread, then appends the lead’s reply, so the AI **continues** the flow instead of sending a second opener.

Example (first reply after Marco’s manual DM):

```json
{
  "platform": "tiktok",
  "user_id": "{{Username}}",
  "username": "{{Full Name}}",
  "message": "{{Last Text Input}}",
  "comment_or_dm": "dm",
  "marco_previous_outbound": "Thanks for reaching out! I'd love to help. Is this going to be your first time going through the buying process?!"
}
```

On later messages, omit `marco_previous_outbound` (conversation already has Marco in history).

---

## Environment: Anthropic (Haiku)

- **`ANTHROPIC_API_KEY`** (required for real AI replies): If unset or empty, opening DM, post-opening pipeline, preflight coaching, and intent classification **skip the API** and use **hardcoded/template fallbacks** so the webhook never returns empty. After adding credits, ensure the key is set on the host (e.g. `fly secrets set ANTHROPIC_API_KEY=sk-ant-...`).
- **`ANTHROPIC_MODEL`** (optional): Defaults to `claude-3-5-haiku-latest`. Override if you standardize on another Haiku snapshot (e.g. `claude-haiku-4-5-20251001`).
- **Health check:** `GET /health` returns `anthropic.api_key_configured` and `anthropic.model` so you can confirm the app sees the key **without** spending tokens. Billing errors still appear at request time; check logs for `llm_opening_error`, `llm_pipeline_error`, or `preflight_error_fallback` and `anthropic_http_status` (e.g. 401/402 when credits or auth fail).
