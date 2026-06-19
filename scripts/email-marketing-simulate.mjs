/**
 * Email marketing smoke test — logs all types to email.db and sends live Gmail samples to Marco.
 * Usage: node scripts/email-marketing-simulate.mjs
 */
import "dotenv/config";

const MARCO_TEST_EMAIL = process.env.MARCO_EMAIL?.trim() || "pmarcopuga@gmail.com";

async function main() {
  const { getEmailDb, logEmail, markEmailSent, markEmailFailed, startDripSequence, getEmailStats, countActiveDripSequences, getRecentEmails } =
    await import("../dist/src/core/emailStore.js");
  const { sendEmail, isEmailConfigured, verifyEmailConnection } = await import("../dist/src/integrations/email/index.js");
  const { createLead, listAllLeads, updateLeadCrmFields, appendMessage } = await import("../dist/src/core/db.js");
  const { sendAutoReply } = await import("../dist/src/agents/emailMarketing/autoReply.js");
  const { processDueBuyerDrips, startBuyerDrip } = await import("../dist/src/agents/emailMarketing/buyerDrip.js");
  const { processDueSellerDrips, startSellerDrip } = await import("../dist/src/agents/emailMarketing/sellerDrip.js");
  const { sendContextAwareEmail } = await import("../dist/src/agents/emailMarketing/existingClientFlow.js");

  getEmailDb();
  console.log("\n=== Email Marketing Simulation ===\n");

  const configured = isEmailConfigured();
  console.log("Gmail configured:", configured);
  if (configured) {
    const ok = await verifyEmailConnection();
    console.log("Gmail verified:", ok);
  }

  // Test lead for dashboard (shows in lead dropdown + drip table)
  let testLead = (await listAllLeads()).find((l) => l.username === "email_sim_test");
  if (!testLead) {
    testLead = await createLead({
      platform: "simulation",
      userId: `email-sim-${Date.now()}`,
      username: "email_sim_test",
      name: "Email Sim Tester",
      phone: null,
      email: null,
      state: "criteria_collected",
      source: "web_form",
      adCampaign: null,
      propertyInquired: "3 bed home in Stone Oak area",
      criteria: { priceCap: 450000, beds: 3, baths: 2, area: "Stone Oak", timeline: "3-6 months" },
      brivityId: null,
      crmStatus: "active",
      crmStage: "nurture",
      crmPriority: "medium",
      crmIntent: "buyer",
      crmCallQueue: "none",
      crmNotes: "Created by email-marketing-simulate.mjs",
    });
    await appendMessage(testLead.id, "user", "Hi Marco, I'm looking for a 3 bed around Stone Oak, budget 450k");
    await updateLeadCrmFields({
      leadId: testLead.id,
      email: MARCO_TEST_EMAIL,
      crmIntent: "buyer",
    });
    testLead = (await listAllLeads()).find((l) => l.id === testLead.id) || testLead;
    console.log("Created test lead:", testLead.id);
  } else {
    console.log("Using existing test lead:", testLead.id);
  }

  const results = [];

  async function runTest(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      console.log(`✓ ${name}`, detail ? `— ${JSON.stringify(detail)}` : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, detail: msg });
      console.log(`✗ ${name} — ${msg}`);
    }
  }

  // 1) auto_reply (live send — direct, not 3-min scheduler)
  await runTest("auto_reply live send", async () => {
    const fresh = (await listAllLeads()).find((l) => l.id === testLead.id);
    if (!fresh) throw new Error("test lead missing");
    await sendAutoReply({ ...fresh, autoReplyEmailSentAt: undefined });
    return { to: MARCO_TEST_EMAIL };
  });

  // 2) buyer_drip step 0 (live)
  await runTest("buyer_drip sequence + process step 0", async () => {
    startBuyerDrip(testLead.id);
    const r = await processDueBuyerDrips();
    return r;
  });

  // 3) seller drip on second sim lead
  let sellerLead = (await listAllLeads()).find((l) => l.username === "email_sim_seller");
  if (!sellerLead) {
    sellerLead = await createLead({
      platform: "simulation",
      userId: `email-sim-seller-${Date.now()}`,
      username: "email_sim_seller",
      name: "Seller Sim",
      phone: null,
      email: MARCO_TEST_EMAIL,
      state: "new",
      source: "mojo",
      adCampaign: null,
      propertyInquired: null,
      criteria: null,
      brivityId: null,
      crmStatus: "active",
      crmStage: "nurture",
      crmPriority: "medium",
      crmIntent: "seller",
      crmCallQueue: "none",
      crmNotes: "Seller drip sim",
    });
  }
  await runTest("seller_drip sequence + process step 0", async () => {
    startSellerDrip(sellerLead.id);
    return await processDueSellerDrips();
  });

  // 4) no_reply_followup (logged + live send)
  await runTest("no_reply_followup (simulated 3-day follow-up)", async () => {
    const subject = "[SIM] Just checking in";
    const body = `Hi Email Sim,\n\nWanted to make sure my last email made it through — no rush, just checking in!\n\nMarco`;
    const rec = logEmail({
      leadId: testLead.id,
      subject,
      body,
      emailType: "no_reply_followup",
      sendStatus: "pending",
    });
    const r = await sendEmail(MARCO_TEST_EMAIL, subject, body);
    if (r.success) markEmailSent(rec.id);
    else markEmailFailed(rec.id, r.error || "fail");
    return { messageId: r.messageId, success: r.success };
  });

  // 5) existing_client manual flow
  await runTest("existing_client context-aware send", async () => {
    return await sendContextAwareEmail(
      testLead.id,
      "[SIM] Quick check-in on your search",
      (ctx) =>
        `Hi ${ctx.leadName},\n\nFollowing up on your home search${ctx.activeDeal ? ` (${ctx.activeDeal.address})` : ""}. ${ctx.lastConversationSnippet ? `Last we chatted: "${ctx.lastConversationSnippet}"` : ""}\n\nMarco`,
    );
  });

  // 6) past_client_quarterly (logged only — avoid duplicate quarterly spam)
  await runTest("past_client_quarterly (logged sample)", async () => {
    const rec = logEmail({
      leadId: testLead.id,
      subject: "[SIM] Happy home anniversary!",
      body: "Hi there,\n\nQuarterly past-client touch sample (simulation log only).\n\nMarco",
      emailType: "past_client_quarterly",
      sendStatus: "sent",
      sentAt: new Date().toISOString(),
    });
    startDripSequence(testLead.id, "past_client_quarterly");
    return { emailId: rec.id };
  });

  // 7) failed send (invalid address — tests failed status in UI)
  await runTest("failed send (invalid address)", async () => {
    const rec = logEmail({
      leadId: testLead.id,
      subject: "[SIM] Should fail",
      body: "invalid recipient test",
      emailType: "manual",
      sendStatus: "pending",
    });
    const r = await sendEmail("not-an-email", "fail test", "body");
    markEmailFailed(rec.id, r.error || "invalid");
    return { error: r.error };
  });

  // 8) opened/replied markers for stats UI
  const recent = getRecentEmails(5);
  if (recent[0]?.id) {
    const { markEmailOpened, markEmailReplied } = await import("../dist/src/core/emailStore.js");
    markEmailOpened(recent[0].id);
    markEmailReplied(testLead.id);
    console.log("✓ marked sample opened + replied on latest email");
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stats = getEmailStats(since);
  const drips = countActiveDripSequences();

  console.log("\n--- Summary ---");
  console.log("Tests:", results.filter((r) => r.ok).length + "/" + results.length, "passed");
  console.log("Emails in last 24h:", stats);
  console.log("Active drip sequences:", drips);
  console.log("\nOpen dashboard: http://localhost:3000/email-marketing");
  console.log("Check Marco inbox for [SIM] and drip subjects.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
