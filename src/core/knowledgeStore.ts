/**
 * 3.4 — Knowledge Center: SOPs and internal documentation.
 *
 * The point is not storage, it's onboarding: a new agent or assistant should
 * be pointed at Harvey instead of being walked through everything by hand.
 * That only works if Harvey can actually read what's in here, so the same
 * documents back both the CRM page and Harvey's `search_knowledge` /
 * `read_knowledge_doc` tools — one source, no second copy to drift.
 *
 * Markdown text, file-backed JSON on the /data volume (same pattern as the
 * other JSON stores). Deliberately not a database: these are a few dozen
 * documents people edit occasionally, and keeping them as plain text is what
 * makes them readable by a language model without a retrieval layer.
 *
 * Search is keyword scoring, not embeddings — no new dependency (the overlay
 * deploy path can't npm install) and at this corpus size an embedding index
 * would be slower to build than it is worth. If the library grows past a few
 * hundred documents this is the piece to revisit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export interface KnowledgeDoc {
  id: string;
  title: string;
  /** Grouping in the sidebar, e.g. "Listings", "Buyers", "Admin". */
  category: string;
  /** Markdown. */
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  /** Seeded docs describe the software; they can be edited or deleted. */
  builtIn?: boolean;
}

interface Persisted {
  docs: KnowledgeDoc[];
}

function resolvePath(): string {
  const explicit = process.env.KNOWLEDGE_JSON_PATH?.trim();
  if (explicit) return explicit;
  if (existsSync("/data")) return "/data/knowledge.json";
  return join(process.cwd(), "data", "knowledge.json");
}

const PATH = resolvePath();
let state: Persisted = { docs: [] };
let loaded = false;

const nowIso = () => new Date().toISOString();

function persist(): void {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[knowledge] persist failed:", err);
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(PATH)) {
      const raw = readFileSync(PATH, "utf8");
      if (raw.trim()) {
        const data = JSON.parse(raw) as Partial<Persisted>;
        state.docs = Array.isArray(data.docs) ? data.docs : [];
      }
    }
  } catch (err) {
    console.error("[knowledge] load failed:", err);
  }
  if (!state.docs.length) seedBuiltIns();
}

/**
 * Starter content so the section and Harvey's tools are useful on day one.
 *
 * These document THE SOFTWARE — how the system works — carried over from the
 * old How to Use tour. They are explicitly NOT Marco's business SOPs (listing
 * process, showing checklist, offer handling); nobody but the team can write
 * those, and inventing them would be worse than an empty shelf.
 */
function seedBuiltIns(): void {
  const t = nowIso();
  const mk = (title: string, category: string, tags: string[], body: string): KnowledgeDoc => ({
    id: randomUUID(), title, category, tags, body: body.trim(),
    createdAt: t, updatedAt: t, builtIn: true,
  });

  state.docs = [
    mk("Signing in and switching users", "Getting started", ["login", "onboarding", "account"], `
# Signing in

Open the site and you'll land on **Who's logging in?** — pick your name. There
is no password; the picker identifies who you are so your tasks, notifications
and messages load for you.

You stay signed in for the browser session. Close the browser and you'll be
asked again — that's deliberate, so the next person on a shared machine isn't
silently signed in as you.

**To switch users:** click your name at the bottom-left of the sidebar.
**To sign out:** the arrow icon next to your name.
`),

    mk("Task Command: assigning work", "Getting started", ["tasks", "assign", "notifications"], `
# Assigning a task

Tasks tab → **Add Task**. Fill in the description and date, then pick who it's
for under **Assign To**. Anyone can assign to anyone.

The moment you save, the assignee gets:

- a **popup** wherever they are in the system, and
- a **red count** on their Tasks tab.

If they're logged out, both appear the next time they sign in — nothing is
missed because they weren't looking.

Tasks roll over: anything incomplete carries to today with a *Missed Task*
banner. The original due date is never rewritten, so "how late is this" stays
honest.
`),

    mk("Message Center: channels", "Day to day", ["messages", "inbox", "instagram", "tiktok", "sms"], `
# Message Center

Conversations are split by channel so a live DM and a text don't share one
list — they carry very different urgency.

- **Instagram / TikTok** — social DMs from the funnel.
- **SMS** — real texts.
- **Email** — email threads.
- **ALL** — everything, with a channel tag on each row.

The red number on each tab is **unread in that channel**, so you can be reading
TikTok and still see Instagram has three waiting.
`),

    mk("Scheduling a message for later", "Day to day", ["schedule", "send later", "sms", "email"], `
# Send later

Open a conversation, type the message, then click the **clock** button.

Three ways to set the time:

1. **Quick picks** — In an hour, Tomorrow 9am, Monday 9am.
2. **Date + time** — pick them explicitly.
3. **Describe it** — "Tuesday morning", "in 2 hours", "tomorrow at 8am".

Whatever you use, the line underneath shows **exactly how it was read** before
you commit. If the wording is ambiguous it says so and refuses rather than
guessing.

Queued messages live under the **SCHEDULED** tab, where you can reschedule or
cancel them.

You can also ask Harvey: *"text Jessica tomorrow morning about the comps."*
`),

    mk("Asking Harvey for a reply", "Day to day", ["harvey", "ai", "suggested reply"], `
# Suggested replies

In any conversation, the **spark** button drafts the next message. Harvey reads
the whole thread plus everything on the contact's record — criteria, stage,
your notes, recent calls — not just the last message.

You get the draft, a one-line *why*, and a note of what it read. Then
**Use it**, **Edit**, or **Ignore**. Nothing sends on its own.

While typing, grey **ghost text** suggests how to finish the sentence.
**Tab** or **→** accepts it, **Esc** dismisses it.
`),

    mk("What Harvey can do for you", "Harvey", ["harvey", "tools", "onboarding"], `
# Harvey

Ask in plain English. Harvey can read the CRM, the Buyers & Sellers tracker,
the task board, content performance, finance and email — and can act on some
of it.

**Reads:** "how many sellers are in the pipeline", "what's overdue",
"show me hot leads", "what did we spend on ads last month".

**Writes:** create and update tasks, move tracker stages, update a contact's
status or stage, log that a call happened, add a new contact, queue a message
for later.

**Onboarding:** ask Harvey anything in this Knowledge Center — *"what's our
process for a new listing?"* — and he answers from these documents.

Harvey will not invent facts. If something isn't in the system he says so
rather than guessing.
`),

    // "load unpacked" and "install" are in the body but the search gate wants a
    // title/tag hit, so the most likely question missed. Tag them.
    mk("Harvey browser control (extension)", "Harvey", ["browser", "extension", "portal", "scraping", "install", "load unpacked", "chrome"], `
# Browser control

Harvey can work inside sites that have no API — pull a listing off a portal,
fill a third-party form, read an MLS back office — by driving **your** Chrome
tab through the Harvey extension.

## Turning it on
1. Download the extension: **/api/browser/extension.zip**. Unzip it (Windows:
   right-click → Extract All) — you want the folder with \`manifest.json\` in it.
2. Chrome → \`chrome://extensions\` → **Developer mode** on → **Load unpacked**
   → pick that unzipped folder.
3. Click the icon, enter the server URL and pairing token, **Save & pair**.
4. Flip **Let Harvey control this browser** on. The badge reads ON.

Chrome only offers "Load unpacked" for a folder that is already on your own
computer — that's why there's a download step; there is no Web Store listing.

## Using it
Just ask:
- "Open this listing and pull the price, address, beds and baths."
- "Fill the request form with my details and submit."

Harvey works in **his own tab**, opened in the background the first time he
needs one. He will never navigate the page you're reading — including this
app — out from under you. If he hasn't opened a tab yet and you ask about the
page you're on, he acts on that one, so "what does this page say about the
HOA?" works without opening anything first.

The extension popup shows which page Harvey is on, so you can check before
asking him to click something.

## When the page is a picture, not text
Ask him to *look* at it — "what does this floor plan show?", "read the price
off that flyer". He takes a screenshot and actually sees it. Useful for maps
of comps, scanned disclosures, floor plans, and anything where the number is
inside an image.

Chrome can only photograph whichever tab is in front, so taking one flicks
your screen to his tab for a moment and puts yours right back. Reading text is
faster, so he only does this when looking is the point.

## Sites that need a login
**You never give Harvey a password.** He works in a tab inside your own Chrome,
so you are already signed in to anything you normally use — the MLS, a title
company portal, your email. Your session is simply there.

If he does hit a sign-in screen, he brings his tab to the front and asks you to
sign in. Do it yourself, then tell him to carry on: the session stays in that
tab and he keeps working from there.

## What it will not do
It cannot read cookies, read saved passwords, type into password fields, or run
arbitrary code. If a form has a password box he fills every other field and
skips that one.

To be clear about why: **this is Harvey's own safety rule, not a Chrome
restriction.** There is no browser setting that turns it on. It exists so
"fill in this form" can never quietly become "type my credentials somewhere",
and because — see above — he does not need your password to do the work.

Switch it off when you're done — off means no command can run at all. You can
also ask him to turn it off, and to turn it back on. If you'd rather he could
never switch it on himself, untick **Let Harvey switch it back on** in the
popup; then only you can arm it.
`),

    mk("How to write an SOP for Harvey", "Harvey", ["sop", "writing", "onboarding"], `
# Writing SOPs Harvey can use

Harvey answers out of these documents, so how they're written matters.

**Do:**
- One process per document. "Listing intake" and "Showing follow-up" are two.
- A clear title — it's the strongest search signal.
- Numbered steps in the order they happen.
- Say who does what: "Carlos sends…", "Marco approves…".
- Include real thresholds and names: "under $250k", "within 24 hours".

**Avoid:**
- One giant document covering everything.
- Vague language — "handle it promptly" tells Harvey nothing useful.
- Screenshots as the only content; Harvey reads text.

**Tags** help retrieval. Tag a listing SOP with \`listing\`, \`seller\`,
\`intake\` and any of those words will find it.
`),
  ];
  persist();
  console.log(`[knowledge] seeded ${state.docs.length} starter documents`);
}

export function listDocs(category?: string): KnowledgeDoc[] {
  load();
  const docs = category
    ? state.docs.filter((d) => d.category.toLowerCase() === category.toLowerCase())
    : state.docs.slice();
  return docs.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

export function listCategories(): { category: string; count: number }[] {
  load();
  const counts = new Map<string, number>();
  for (const d of state.docs) counts.set(d.category, (counts.get(d.category) || 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function getDoc(id: string): KnowledgeDoc | undefined {
  load();
  return state.docs.find((d) => d.id === id);
}

export interface DocInput {
  title: string;
  category?: string;
  body: string;
  tags?: string[];
  updatedBy?: string;
}

export function createDoc(input: DocInput): KnowledgeDoc {
  load();
  const t = nowIso();
  const doc: KnowledgeDoc = {
    id: randomUUID(),
    title: input.title.trim(),
    category: (input.category || "Uncategorised").trim(),
    body: input.body,
    tags: (input.tags || []).map((x) => String(x).trim()).filter(Boolean),
    createdAt: t,
    updatedAt: t,
    updatedBy: input.updatedBy,
  };
  state.docs.push(doc);
  persist();
  return doc;
}

export function updateDoc(id: string, patch: Partial<DocInput>): KnowledgeDoc | undefined {
  load();
  const doc = state.docs.find((d) => d.id === id);
  if (!doc) return undefined;
  if (patch.title !== undefined) doc.title = patch.title.trim();
  if (patch.category !== undefined) doc.category = patch.category.trim() || "Uncategorised";
  if (patch.body !== undefined) doc.body = patch.body;
  if (patch.tags !== undefined) doc.tags = patch.tags.map((x) => String(x).trim()).filter(Boolean);
  if (patch.updatedBy !== undefined) doc.updatedBy = patch.updatedBy;
  doc.updatedAt = nowIso();
  // An edited built-in is now the team's document, not starter content.
  doc.builtIn = false;
  persist();
  return doc;
}

export function deleteDoc(id: string): boolean {
  load();
  const before = state.docs.length;
  state.docs = state.docs.filter((d) => d.id !== id);
  if (state.docs.length === before) return false;
  persist();
  return true;
}

export interface DocHit {
  id: string;
  title: string;
  category: string;
  tags: string[];
  score: number;
  /** The matching passage, for showing why it matched. */
  excerpt: string;
}

/**
 * Keyword search over title, tags, category and body.
 *
 * Title and tag matches outweigh body matches, because a document *named*
 * "Listing intake" is almost always the right answer for "listing intake"
 * even if another document mentions the phrase more often.
 */
/**
 * Words that carry no retrieval signal. Without this, "what is our process
 * for X" matches nearly every document on "our"/"for"/"process" alone.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "our", "you", "your", "what", "how", "when", "who", "why",
  "with", "from", "are", "was", "can", "this", "that", "they", "has", "have",
  "its", "not", "but", "all", "any", "does", "did", "get", "got", "use", "using",
  "about", "into", "out", "off", "there", "their", "them", "his", "her", "she",
  "him", "were", "been", "being", "just", "like", "than", "then", "now",
]);

export function searchDocs(query: string, limit = 5): DocHit[] {
  load();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!terms.length) return [];

  const hits: DocHit[] = [];
  for (const doc of state.docs) {
    const title = doc.title.toLowerCase();
    const tags = doc.tags.join(" ").toLowerCase();
    const category = doc.category.toLowerCase();
    const body = doc.body.toLowerCase();

    let score = 0;
    let matched = 0;   // how many distinct query terms appear anywhere
    let strong = false; // did any term hit a title/tag/category
    for (const term of terms) {
      let termHit = false;
      if (title.includes(term)) { score += 10; strong = true; termHit = true; }
      if (tags.includes(term)) { score += 6; strong = true; termHit = true; }
      if (category.includes(term)) { score += 3; strong = true; termHit = true; }
      const occurrences = body.split(term).length - 1;
      if (occurrences > 0) { score += Math.min(occurrences, 5); termHit = true; }
      if (termHit) matched++;
    }

    /*
     * Relevance gate. Weak keyword overlap used to return five documents for
     * a genuinely undocumented question ("commission split for referral
     * partners"), which is the worst outcome here: Harvey would cite an
     * unrelated SOP with confidence instead of saying it isn't written down.
     * A hit now needs most of the query's meaningful words present, and at
     * least one of them in a title, tag or category.
     */
    const needed = Math.max(1, Math.ceil(terms.length * 0.6));
    if (matched < needed || !strong) continue;

    // Show the passage around the first hit so the answer is traceable.
    let excerpt = doc.body.slice(0, 240);
    for (const term of terms) {
      const at = body.indexOf(term);
      if (at >= 0) {
        excerpt = doc.body.slice(Math.max(0, at - 90), Math.min(doc.body.length, at + 190));
        break;
      }
    }
    hits.push({
      id: doc.id, title: doc.title, category: doc.category, tags: doc.tags,
      score, excerpt: excerpt.replace(/\s+/g, " ").trim(),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function knowledgeStats(): { docs: number; categories: number; builtIn: number } {
  load();
  return {
    docs: state.docs.length,
    categories: listCategories().length,
    builtIn: state.docs.filter((d) => d.builtIn).length,
  };
}
