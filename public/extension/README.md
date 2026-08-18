# Harvey Browser Control

Two things: a **side panel** where you talk to Harvey next to whatever page
you're on, and the ability for him to **work inside sites that have no API** —
pull a listing off a portal, fill out a third-party form, read a page in an MLS
back office.

Click the toolbar icon and the panel opens beside the tab. It stays open while
you click around, which is the whole point: *"what do you make of this
listing?"* is a question about the page you're looking at, and a popup would
close the moment you looked at it.

The panel is the full Harvey — the same brain, tools and memory as the shell,
not a cut-down version — and it uses the pairing token you already entered, so
there is no second login.

Harvey acts in **your** browser, with your existing logins — and only while you
switch it on.

He works in **his own window**, which he opens the first time he needs one and
brings to the front so you can see what he opened. The page you're reading —
including the Harvey shell itself — is never navigated out from under you.

A separate window rather than a tab is deliberate: it keeps the Harvey shell
the active tab of *its* window, so the microphone and the speech connection
stay awake. Browsers throttle hidden tabs hard, and a hidden shell is what
makes Harvey appear to stop listening.

## Install

1. Set the pairing tokens on the server (once). **Give each person their own** —
   one token per account, separated by commas:

   ```
   flyctl secrets set BROWSER_CONTROL_TOKENS="marco:<random>,carlos:<random>,wesley:<random>" -a marco-90-automation
   ```

   Without at least one token, browser control is disabled entirely — it fails
   closed.

   Why one each rather than one shared string: a browser belongs to the account
   whose token it paired with, so Carlos asking Harvey to open a listing drives
   *Carlos's* browser and never Marco's, and the two of them can work at the
   same time without fighting over the bus. Each person also gets their own
   conversation thread in the panel. Removing someone is deleting their entry;
   nobody else has to re-pair.

   The older single `BROWSER_CONTROL_TOKEN` still works and becomes an account
   of its own, so browsers paired before this change keep working untouched.

2. Get the extension folder onto the machine that will run it. Either clone the
   repo, or download it from the running server — no clone needed:

   ```
   https://marco-90-automation.fly.dev/api/browser/extension.zip
   ```

   Unzip it (Windows: right-click → **Extract All**). You should end up with a
   folder containing `manifest.json`.

3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and select that unzipped folder — the one with
   `manifest.json` directly inside it, not its parent.

4. Click the extension icon. The panel opens; click **Setup** and enter:
   - **This browser's name** — e.g. `Marco's laptop`
   - **Server** — `https://marco-90-automation.fly.dev`
   - **Your pairing token** — *your own* value from step 1, not someone else's

   Press **Save & pair**. The header shows your account name and "standby".

5. When you want Harvey to work in the browser, flip
   **Let Harvey control this browser** on. The badge shows `ON`.

## Using it

Type in the panel, or ask Harvey from the shell or by voice — same Harvey
either way. Your conversation in the panel is kept per browser, so closing and
reopening it picks up where you left off. **Clear** starts a fresh thread.

Things worth asking from the panel:

- *"Open this listing and pull the price, address, beds and baths."*
- *"Open these three listings in tabs and compare the price per square foot."*
- *"Scroll the results and give me everything under $400k, not just the first page."*
- *"Fill in the request form with my details and submit it."*
- *"What does this page say about the HOA?"*
- *"The form didn't submit — what did the page complain about?"*

Harvey checks whether the extension is connected before trying, and tells you
what to fix if it isn't.

## What it can and cannot do

**Can:** open and navigate his own tabs, work across **several tabs at once**
(collected into a cyan "Harvey" tab group you can drag your own tabs into),
click links and buttons, type into form fields, read visible page text, extract
named values by selector, scroll lazy-loading result panes, read the page's own
structured data, take a screenshot, and report the page errors a site logged
when something silently failed.

If Harvey hasn't opened a tab yet and you ask him about a page, he acts on the
tab you're currently on — so *"what does this page say about the HOA?"* works
without asking him to open it first. The Harvey shell is excluded from that:
he'll never treat his own UI as the page in question.

He reads a page's schema.org JSON-LD before guessing at CSS selectors, sees
through open shadow roots **and every iframe including cross-origin ones**
(embedded frames are labelled in what he reads back), waits for content that
loads after the page does, and scrolls to pull in lazy-loaded results.

Scrolling finds **whatever actually scrolls** — most portals scroll an inner
results pane rather than the window — and reports whether the content grew, so
"that's the whole list" and "there is more below" are different answers rather
than the same silence. A long page comes back in chunks with an offset to
continue from, so the bottom of a page is reachable instead of being cut off.

He can also **look** at the page — a screenshot, for things that only make
sense visually: a map of comps, a scanned disclosure, a floor plan, a number
baked into an image. Chrome can only photograph the tab that's in front, so
taking one flicks the screen to his tab for a moment and puts yours straight
back. That flicker is the API, not a bug.

**Cannot, by design:** read cookies, read `localStorage`, run arbitrary
JavaScript, or type into **passwords, card numbers, CVV/security codes, or
Social Security / tax ID fields**. Those turn "fill in this form" into
"exfiltrate this session" or "make a payment", and nothing in the use case
needs them. Sensitive fields are matched on the field's own `autocomplete`,
name, id and placeholder rather than on the selector asked for, so aiming at a
card box by id does not get around it.

He also **never solves or bypasses a CAPTCHA**. He can tell you one is there;
you complete it and he carries on.

**Site rules**, matching what Claude in Chrome enforces:

- **Adult and piracy sites are blocked outright.** Not a setting.
- **Financial sites** — banks, brokerages, payment and title portals — can be
  **read**, but clicking, typing or navigating on one needs you to allow that
  specific host first. A grant covers that host only; allowing Chase does not
  allow Wells Fargo.

These are *this extension's* rules, not browser restrictions — there is no
Chrome setting that relaxes them, and they are enforced in the extension rather
than on the server, so a spoofed or compromised server still cannot talk Harvey
into typing a card number.

## Logins

You never hand over a password. Harvey's tab runs in your own Chrome profile,
so you are already signed in to whatever you normally use. At a sign-in screen
he brings the tab forward and asks you to log in; the session persists there
and he continues from it.

## Safety

- Off by default; you arm it per session.
- Switched off, the extension still reports in but receives no commands.
- Every action is recorded server-side with its result — `/api/browser/status`
  returns the recent trail.
- Switch it off when you're done.

Treat your pairing token like a password, and don't pass it around — it is
yours, and sharing it puts someone else's commands on your browser. Anyone
holding it and the server URL can queue actions for whatever browser is armed
**on that account**, and can talk to Harvey as that account. They cannot see or
drive anyone else's browsers.
