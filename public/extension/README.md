# Harvey Browser Control

Version 1.9.0 adds the signed-in chat connection to this existing extension package. The manifest name, background service worker, icons, side panel and legacy integration are retained. A repository copy is not proof of a Chrome Web Store listing. If an existing listing is available, upload this as an update to that same listing to preserve its extension ID.

## Current account-isolated app

1. Install/enable the extension once and reload Harvey. During development, unzip the package and use Chrome → Extensions → Developer mode → Load unpacked.
2. In Harvey, choose **Use my browser**, enter the site and choose **Open browser tab**.
3. Sign in yourself in the new tab. Return to Harvey and choose **Ready — allow control**. Chrome displays its debugger-control notice.
4. Ask Harvey to work. Use **View tab** to watch and **Stop control** to stop. The website tab stays open.

There is no pairing-token entry for this flow. The signed-in Harvey page relays commands to exactly the tab the extension opened. Only the owner of the chat may connect; Carlos's ability to view another owner's chats does not permit controlling that owner's browser. One connection is allowed per Chrome profile. A chat switch, closed controller tab, closed target tab, debugger detach or lost heartbeat stops control. Schedules and delegated tasks cannot use the local connection. Reconnection is explicit; the app does not silently use its hosted computer instead. Select **Hosted computer** to switch back when the chat has no running task.

The trusted application origin is `https://marco-90-automation.fly.dev`. This is not full desktop control. The browser must remain open and connected.

## Supported local actions

Fresh page observations and screenshots; HTTP(S) navigation/back; observed clicks, hover in the top frame, ordinary form filling, native selects, bounded keyboard/scroll actions, rendered table reads, and pointer drags between observed controls or fresh screenshot coordinates. Open shadow roots and accessible frames are observed separately. Cross-frame reference clicks use DOM clicks; sites requiring trusted input there can use fresh screenshot coordinates. Native dialogs, downloads/uploads, password entry, CAPTCHA and security approvals are handled by the human. Closed shadow roots and Chrome-internal pages are not accessible. This is not a promise of full hosted Playwright feature parity or exemption from a site's automation restrictions.

Page output is untrusted data. The extension does not expose arbitrary model JavaScript execution, cookie-reading or password extraction APIs. Rendered rows and viewport screenshots are partial observations, not proof of complete coverage. Interrupted writes are never automatically replayed.

## Retained legacy side panel

The original token-paired side panel remains for compatible non-isolated deployments. The current account-isolated gateway does not route its unscoped legacy pairing bus. Use the signed-in Harvey chat flow above. Legacy control must be off before connecting a chat; its polling/actions are suspended during the chat connection. The side panel provides an Open Harvey link and a Stop connected tab button.

## Verification and distribution

`npm run build`, `node scripts/verify-mls-live.mjs`, `PW_CHROMIUM=/path/to/chrome node scripts/verify-local-browser.mjs` and `PW_CHROMIUM=/path/to/chrome node scripts/verify-browser-extension.mjs` exercise the implementation. CI also runs the account gateway, DM and hosted-browser regression suites.

See `docs/harvey-browser-publishing.md` in the repository for store listing text, permission explanations and publication prerequisites. Chrome requires the user to approve extension installation and any new permissions. A published listing/developer account is still needed for normal Add to Chrome installation.
