# Harvey Browser Control: publishing package

## Listing draft

Name: Harvey Browser Control

Summary: Connect a chosen Chrome tab to Harvey, sign in yourself, and let Harvey work while you watch. Stop control anytime.

Description: Use your signed-in Harvey chat to open a website in Chrome. Sign in yourself, then allow Harvey to work in the connected tab. Harvey can inspect pages, click controls, fill ordinary forms, read tables and use screenshots and pointer gestures. You can watch the tab and stop control at any time. Your unrelated tabs are not targets of the chat connection. Requires a Harvey account, Chrome 125 or later and an active connection. Website support varies. Login challenges and native file dialogs remain under your control.

## Existing listing or new submission

The repository contains an existing extension, but no verified store listing ID or publisher account. Reuse an existing listing if its owner can provide access; do not create a duplicate. Otherwise register a Chrome Web Store developer account and submit this package. Store approval is separate from merging/deploying Harvey. Do not display a fabricated store link. After approval, replace the development installation instructions in Harvey with the verified Add to Chrome URL. The extension still requires one-time user installation and permission approval.

The package keeps the original manifest identity fields and version-increments to 1.9.0. Store updates retain the existing ID. An unpacked installation's generated ID is not evidence of a store identity.

## Permission explanations

- debugger: capture the connected tab and dispatch fixed mouse/keyboard commands. Chrome shows a control banner. No arbitrary model code execution API is exposed.
- scripting and host access: inspect and operate the user-chosen website, including frames/open shadow roots. Broad host access supports arbitrary user-chosen sites; the new relay content script runs only on the Harvey application origin.
- tabs, activeTab and tabGroups: create/focus the connected tab and preserve the existing extension's legacy browser workflow.
- storage and alarms: retained legacy configuration/device identity and background polling. New chat connection secrets are held by the signed-in app in memory, not extension storage.
- sidePanel: retained legacy side panel and the connection stop/open controls.

Explain the retained legacy mode to the reviewer: it requires explicit operator configuration and is not used by the current account-isolated app. Disable that mode before a chat connection. No remotely hosted executable code is loaded by the new connection.

## Privacy disclosure draft — publisher review required

The extension processes website content, URLs, titles, screenshots and actions for tasks the user requests. During an authorized connection, these observations are transmitted through the signed-in Harvey application and may be included in the chat's configured AI provider requests and retained chat/tool history under the application's policies. Website sessions remain in the user's browser; this connection does not export cookies, browser storage or saved passwords. Ordinary form text entered for a requested task is processed. Credentials and sensitive verification fields require manual user entry.

The retained legacy mode can also report the operator's active tab metadata to its configured server while paired; this is separate from the new chat-only connection and must be included in the publisher's disclosure if retained in the store package. No claim of collecting zero website data is appropriate.

Before submission, the publisher must finalize its legal business/contact details, retention/deletion practices, AI-provider disclosures and publicly accessible privacy-policy URL. This draft is not a published policy. Complete the store's data-use declarations consistently, supply reviewer account access/test instructions, and capture listing screenshots using fixture data. Do not include API keys, pairing tokens or real customer data in the package or screenshots.

## Reviewer walkthrough

Sign in to the supplied test Harvey account. Click Use my browser, enter a test site, open its tab, then return and allow control. Ask Harvey to read a heading and fill a harmless fixture field. Verify the visible tab, Stop control, and confirm it remains open. Other accounts cannot connect to the same chat's browser. Hosted computer remains separately selectable. Test package: the `public/extension` directory zipped with `manifest.json` at the archive root.
