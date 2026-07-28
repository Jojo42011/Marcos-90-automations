# Harvey Browser Control

Lets Harvey work inside sites that have no API — pull a listing off a portal,
fill out a third-party form, read a page in an MLS back office.

Harvey acts in **your** browser, in **your** active tab, with your existing
logins — and only while you switch it on.

## Install

1. Set the pairing token on the server (once):

   ```
   flyctl secrets set BROWSER_CONTROL_TOKEN="<a long random string>" -a marco-90-automation
   ```

   Without this, browser control is disabled entirely — it fails closed.

2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and select this `extension/` folder.

3. Click the extension icon and enter:
   - **Server** — `https://marco-90-automation.fly.dev`
   - **Pairing token** — the same value from step 1

   Press **Save & pair**. The dot turns grey/"Paired · standby".

4. When you want Harvey to work in the browser, flip
   **Let Harvey control this browser** on. The badge shows `ON`.

## Using it

Ask Harvey normally:

- *"Open this listing and pull the price, address, beds and baths."*
- *"Fill in the request form with my details and submit it."*
- *"What does this page say about the HOA?"*

Harvey checks whether the extension is connected before trying, and tells you
what to fix if it isn't.

## What it can and cannot do

**Can:** navigate the active tab, click links and buttons, type into form
fields, read visible page text, extract named values by selector.

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
