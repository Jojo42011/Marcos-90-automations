# Harvey Browser Control

Lets Harvey work inside sites that have no API — pull a listing off a portal,
fill out a third-party form, read a page in an MLS back office.

Harvey acts in **your** browser, with your existing logins — and only while you
switch it on.

He works in **his own tab**, opened in the background the first time he needs
one. The page you're reading — including the Harvey shell itself — is never
navigated out from under you.

## Install

1. Set the pairing token on the server (once):

   ```
   flyctl secrets set BROWSER_CONTROL_TOKEN="<a long random string>" -a marco-90-automation
   ```

   Without this, browser control is disabled entirely — it fails closed.

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

4. Click the extension icon and enter:
   - **Server** — `https://marco-90-automation.fly.dev`
   - **Pairing token** — the same value from step 1

   Press **Save & pair**. The dot turns grey/"Paired · standby".

5. When you want Harvey to work in the browser, flip
   **Let Harvey control this browser** on. The badge shows `ON`.

## Using it

Ask Harvey normally:

- *"Open this listing and pull the price, address, beds and baths."*
- *"Fill in the request form with my details and submit it."*
- *"What does this page say about the HOA?"*

Harvey checks whether the extension is connected before trying, and tells you
what to fix if it isn't.

## What it can and cannot do

**Can:** open and navigate his own tab, click links and buttons, type into form
fields, read visible page text, extract named values by selector.

If Harvey hasn't opened a tab yet and you ask him about a page, he acts on the
tab you're currently on — so *"what does this page say about the HOA?"* works
without asking him to open it first. The Harvey shell is excluded from that:
he'll never treat his own UI as the page in question.

**Cannot, by design:** read cookies, read `localStorage`, type into password
fields, or run arbitrary JavaScript. Those turn "fill in this form" into
"exfiltrate this session", and nothing in the use case needs them.

## Safety

- Off by default; you arm it per session.
- Switched off, the extension still reports in but receives no commands.
- Every action is recorded server-side with its result — `/api/browser/status`
  returns the recent trail.
- Switch it off when you're done.

Treat the pairing token like a password. Anyone holding it and the server URL
can queue actions for whatever browser is armed.
