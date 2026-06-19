/**
 * Gmail OAuth diagnostic — profile + optional test send.
 * Usage: node scripts/gmail-diagnose.mjs
 *        node scripts/gmail-diagnose.mjs --send-to you@example.com
 */
import "dotenv/config";

const sendTo = process.argv.includes("--send-to")
  ? process.argv[process.argv.indexOf("--send-to") + 1]
  : null;

const { isGmailConfigured, sendEmail } = await import("../dist/src/integrations/gmail/index.js");

console.log("=== Gmail diagnostic ===");
console.log("configured:", isGmailConfigured());
console.log("GMAIL_FROM env:", process.env.GMAIL_FROM?.trim() || process.env.GMAIL_USER?.trim() || "(not set — uses OAuth profile)");

if (!isGmailConfigured()) {
  console.error("Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN");
  process.exit(1);
}

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const tokenData = await tokenRes.json();
if (!tokenRes.ok || !tokenData.access_token) {
  console.error("token refresh failed:", JSON.stringify(tokenData, null, 2));
  process.exit(1);
}
console.log("token refresh: OK, expires_in:", tokenData.expires_in);

const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { Authorization: `Bearer ${tokenData.access_token}` },
});
const profile = await profileRes.json();
console.log("profile status:", profileRes.status);
console.log("sending account:", profile.emailAddress || "(unknown)");
console.log("messagesTotal:", profile.messagesTotal);

if (!profile.emailAddress) {
  console.error("profile lookup failed:", JSON.stringify(profile, null, 2));
  process.exit(1);
}

if (sendTo) {
  console.log("\n--- test send to", sendTo, "---");
  try {
    const result = await sendEmail({
      to: sendTo,
      subject: "Harvey Gmail diagnostic test",
      body: `Test send at ${new Date().toISOString()} from ${profile.emailAddress}`,
    });
    console.log("send result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("send failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
} else {
  console.log("\nPass --send-to your@email.com to run a live send test.");
}
