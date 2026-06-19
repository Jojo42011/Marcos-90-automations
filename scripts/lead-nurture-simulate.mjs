/**
 * Lead Nurture smoke test — scoring tiers, source routing, warm/cold touches, API checks.
 * Usage: npm run build && node scripts/lead-nurture-simulate.mjs
 */
import "dotenv/config";

const BASE = process.env.SIM_BASE_URL?.trim() || "http://localhost:3000";
const TEST_PHONE = "+15559001001";

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function apiPost(path) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" } });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function main() {
  const { getLeadScoreDb } = await import("../dist/src/core/leadScoreStore.js");
  const { createLead, listAllLeads, updateLeadCrmFields, getLeadById } = await import("../dist/src/core/db.js");
  const { logSmsMessage } = await import("../dist/src/core/smsStore.js");
  const { scoreAndRecordLead, scoreAllLeads, scoreColdLeads } = await import(
    "../dist/src/agents/leadScoring/index.js"
  );
  const { getLeadsByTier, getLatestScore } = await import("../dist/src/core/leadScoreStore.js");
  const { routeNewLead } = await import("../dist/src/agents/leadNurture/sourceRouting.js");
  const { runWarmLeadWeeklyTouch } = await import("../dist/src/agents/leadNurture/warmLeadFlow.js");
  const { runColdLeadMonthlyTouch } = await import("../dist/src/agents/leadNurture/coldLeadFlow.js");

  getLeadScoreDb();
  console.log("\n=== Lead Nurture Simulation ===\n");

  const results = [];
  async function runTest(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      console.log(`✓ ${name}`, detail != null ? `— ${JSON.stringify(detail)}` : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, detail: msg });
      console.log(`✗ ${name} — ${msg}`);
    }
  }

  async function ensureLead(username, factory) {
    let lead = (await listAllLeads()).find((l) => l.username === username);
    if (!lead) {
      lead = await createLead(factory());
      console.log(`  Created ${username} → id ${lead.id}`);
    } else {
      console.log(`  Using existing ${username} → id ${lead.id}`);
    }
    return lead;
  }

  const hotLead = await ensureLead("nurture_sim_hot", () => ({
    platform: "simulation",
    userId: `nurture-hot-${Date.now()}`,
    username: "nurture_sim_hot",
    name: "Nurture Sim Hot",
    phone: TEST_PHONE,
    email: null,
    state: "criteria_collected",
    source: "instagram",
    adCampaign: null,
    propertyInquired: "4 bed in Stone Oak",
    criteria: { priceCap: 550000, beds: 4, baths: 3, area: "Stone Oak", timeline: "ASAP — ready to move now" },
    brivityId: null,
    crmStatus: "active",
    crmStage: "nurture",
    crmPriority: "high",
    crmIntent: "buyer",
    crmCallQueue: "none",
    crmNotes: "Lead nurture sim — hot tier",
  }));

  const warmLead = await ensureLead("nurture_sim_warm", () => ({
    platform: "simulation",
    userId: `nurture-warm-${Date.now()}`,
    username: "nurture_sim_warm",
    name: "Nurture Sim Warm",
    phone: "+15559001002",
    email: null,
    state: "phone_captured",
    source: "tiktok",
    adCampaign: null,
    propertyInquired: "Townhome near Alamo Ranch",
    criteria: { priceCap: 380000, beds: 3, baths: 2, area: "Alamo Ranch", timeline: "1-3 months" },
    brivityId: null,
    crmStatus: "active",
    crmStage: "nurture",
    crmPriority: "medium",
    crmIntent: "buyer",
    crmCallQueue: "none",
    crmNotes: "Lead nurture sim — warm tier",
  }));

  const coldLead = await ensureLead("nurture_sim_cold", () => ({
    platform: "simulation",
    userId: `nurture-cold-${Date.now()}`,
    username: "nurture_sim_cold",
    name: "Nurture Sim Cold",
    phone: "+15559001003",
    email: null,
    state: "new",
    source: "web_form",
    adCampaign: null,
    propertyInquired: null,
    criteria: { priceCap: null, beds: null, baths: null, area: null, timeline: "just looking / exploring" },
    brivityId: null,
    crmStatus: "active",
    crmStage: "new",
    crmPriority: "low",
    crmIntent: "buyer",
    crmCallQueue: "none",
    crmNotes: "Lead nurture sim — cold tier",
  }));

  const mojoLead = await ensureLead("nurture_sim_mojo", () => ({
    platform: "simulation",
    userId: `nurture-mojo-${Date.now()}`,
    username: "nurture_sim_mojo",
    name: "Nurture Sim Mojo",
    phone: "+15559001004",
    email: null,
    state: "phone_captured",
    source: "mojo",
    adCampaign: null,
    propertyInquired: "Seller lead — Canyon Lake area",
    criteria: null,
    brivityId: null,
    crmStatus: "active",
    crmStage: "nurture",
    crmPriority: "medium",
    crmIntent: "seller",
    crmCallQueue: "call_queue",
    crmNotes: "Lead nurture sim — mojo routing",
  }));

  const referralLead = await ensureLead("nurture_sim_referral", () => ({
    platform: "simulation",
    userId: `nurture-ref-${Date.now()}`,
    username: "nurture_sim_referral",
    name: "Nurture Sim Referral",
    phone: "+15559001005",
    email: null,
    state: "phone_captured",
    source: "referral",
    adCampaign: null,
    propertyInquired: "Referred by past client",
    criteria: { priceCap: 420000, beds: 3, baths: 2, area: "Boerne", timeline: "3-6 months" },
    brivityId: null,
    crmStatus: "active",
    crmStage: "nurture",
    crmPriority: "medium",
    crmIntent: "buyer",
    crmCallQueue: "none",
    crmNotes: "Lead nurture sim — referral routing",
  }));

  await runTest("configure hot lead CRM fields", async () => {
    await updateLeadCrmFields({
      leadId: hotLead.id,
      preApprovalStatus: "approved",
      propertyViewsCount: 5,
      showingAppointment: {
        address: "1397 Canyon Lake Dr",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        confirmationStatus: "confirmed",
      },
      criteria: { timeline: "ASAP — ready to move now" },
    });
    for (let i = 0; i < 6; i++) {
      logSmsMessage({
        leadId: hotLead.id,
        messageBody: `Sim inbound reply ${i + 1}`,
        direction: "inbound",
        sentAt: new Date().toISOString(),
        threadType: "dm",
      });
    }
    return { inboundMessages: 6 };
  });

  await runTest("configure warm lead CRM fields", async () => {
    await updateLeadCrmFields({
      leadId: warmLead.id,
      preApprovalStatus: "in_progress",
      propertyViewsCount: 2,
      criteria: { timeline: "1-3 months" },
    });
    logSmsMessage({
      leadId: warmLead.id,
      messageBody: "Still interested, send listings",
      direction: "inbound",
      sentAt: new Date().toISOString(),
      threadType: "dm",
    });
    return { preApproval: "in_progress" };
  });

  await runTest("configure cold lead CRM fields", async () => {
    await updateLeadCrmFields({
      leadId: coldLead.id,
      preApprovalStatus: "not_approved",
      propertyViewsCount: 0,
      criteria: { timeline: "just looking / exploring" },
    });
    return { timeline: "exploring" };
  });

  await runTest("score hot lead", async () => {
    const lead = await getLeadById(hotLead.id);
    const r = scoreAndRecordLead(lead);
    if (r.tier !== "hot") throw new Error(`expected hot, got ${r.tier} score ${r.score}`);
    return r;
  });

  await runTest("score warm lead", async () => {
    const lead = await getLeadById(warmLead.id);
    const r = scoreAndRecordLead(lead);
    if (r.tier !== "warm") throw new Error(`expected warm, got ${r.tier} score ${r.score}`);
    return r;
  });

  await runTest("score cold lead", async () => {
    const lead = await getLeadById(coldLead.id);
    const r = scoreAndRecordLead(lead);
    if (r.tier !== "cold") throw new Error(`expected cold, got ${r.tier} score ${r.score}`);
    return r;
  });

  await runTest("score all leads", async () => {
    return scoreAllLeads();
  });

  await runTest("tier counts after score-all", async () => {
    const hot = getLeadsByTier("hot").length;
    const warm = getLeadsByTier("warm").length;
    const cold = getLeadsByTier("cold").length;
    if (hot < 1) throw new Error("expected at least 1 hot lead");
    return { hot, warm, cold };
  });

  await runTest("promote cold lead then rescore cold", async () => {
    await updateLeadCrmFields({
      leadId: coldLead.id,
      preApprovalStatus: "approved",
      criteria: { timeline: "ASAP" },
      propertyViewsCount: 4,
    });
    scoreAndRecordLead(await getLeadById(coldLead.id));
    const before = getLatestScore(coldLead.id);
    const rescore = await scoreColdLeads();
    const after = getLatestScore(coldLead.id);
    return { beforeTier: before?.tier, afterTier: after?.tier, afterScore: after?.score, rescore };
  });

  await runTest("source routing — mojo", async () => {
    const lead = await getLeadById(mojoLead.id);
    await routeNewLead(lead);
    return { source: lead.source };
  });

  await runTest("source routing — referral", async () => {
    const lead = await getLeadById(referralLead.id);
    await routeNewLead(lead);
    const updated = await getLeadById(referralLead.id);
    return { crmPriority: updated?.crmPriority };
  });

  await runTest("source routing — web_form", async () => {
    const lead = await getLeadById(coldLead.id);
    await routeNewLead(lead);
    return { scheduled: "2min auto-response timer" };
  });

  await runTest("warm weekly touch (manual)", async () => {
    return runWarmLeadWeeklyTouch();
  });

  await runTest("cold monthly touch (manual)", async () => {
    return runColdLeadMonthlyTouch();
  });

  await runTest("API GET /api/lead-nurture/summary", async () => {
    const { ok, data } = await apiGet("/api/lead-nurture/summary");
    if (!ok) throw new Error(JSON.stringify(data));
    return { hotCount: data.hotCount, warmCount: data.warmCount, coldCount: data.coldCount };
  });

  await runTest("API GET /api/lead-nurture/tier-detail/hot", async () => {
    const { ok, data } = await apiGet("/api/lead-nurture/tier-detail/hot");
    if (!ok) throw new Error(JSON.stringify(data));
    if (!data.count || data.count < 1) throw new Error("expected at least 1 hot lead in API");
    const top = data.leads[0];
    if (!top || top.score < 80) throw new Error("top hot lead score < 80");
    return { count: data.count, topName: top.name, topScore: top.score };
  });

  await runTest("API GET /api/lead-nurture/recently-routed", async () => {
    const { ok, data } = await apiGet("/api/lead-nurture/recently-routed");
    if (!ok) throw new Error(JSON.stringify(data));
    return { routed: data.routed?.length ?? 0, sourceActivity: data.sourceActivity };
  });

  await runTest("API POST /api/lead-scoring/rescore-cold-now", async () => {
    const { ok, data } = await apiPost("/api/lead-scoring/rescore-cold-now");
    if (!ok) throw new Error(JSON.stringify(data));
    return data;
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Done: ${passed}/${results.length} passed ===`);
  if (failed.length) {
    console.log("Failures:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("\nOpen http://localhost:3000/lead-nurture to view results.");
  console.log("Restart the server if sim leads (Nurture Sim Hot/Warm/Cold) are not visible in the UI.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
