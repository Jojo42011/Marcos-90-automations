import { randomUUID } from "crypto";
import { getHullDb } from "./store.js";
import { upsertNode } from "./nodes.js";

const DIMENSIONS = [
  "DECISIONS",
  "VALUES",
  "FEARS",
  "MOTIVATION",
  "EMOTIONS",
  "RELATIONSHIPS",
  "MONEY",
  "IDENTITY",
  "VISION",
  "CONFLICT",
  "LEARNING",
  "ENERGY",
];

export function bootstrapHullMemory(): void {
  const db = getHullDb();

  const factCount = (db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;
  if (factCount > 0) {
    console.log("[hull/memory] Already bootstrapped with", factCount, "facts");
    return;
  }

  console.log("[hull/memory] Bootstrapping Marco founder layer...");

  const now = new Date().toISOString();
  const insertFact = db.prepare(
    `INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  );

  const semanticFacts = [
    { content: "Marco's $20M goal target date is November 30, 2026", category: "business", keywords: "goal,20m,target", strength: 2.0 },
    { content: "Marco has banked $5,956,520 across 14 deals — 29.8% of $20M goal", category: "funnel", keywords: "goal,banked,production", strength: 2.0 },
    { content: "Gap to $20M goal is $14,043,480 — needs 21 buyer closings and 14 seller closings", category: "funnel", keywords: "goal,gap,closings", strength: 2.0 },
    { content: "Average deal price is $425,466", category: "business", keywords: "deal,price,average", strength: 1.5 },
    { content: "Daily non-negotiables: 7 videos per day and 725 calls per day", category: "business", keywords: "daily,target,videos,calls", strength: 2.0 },
    { content: "TikTok closing funnel: 246,227 views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 4 showings → 1 closing", category: "funnel", keywords: "tiktok,funnel,conversion", strength: 1.8 },
    { content: "At 5 videos per week Marco gets 1 closing every 8 weeks from TikTok. Needs 10.3 videos per week for monthly closings", category: "funnel", keywords: "tiktok,pace,closing", strength: 1.8 },
    { content: "Mojo dialer funnel Jan to May 2026: 26,938 calls → 846 contacts → 37 consults → 25 appointments → 8 agreements → 4 closings", category: "funnel", keywords: "mojo,calls,cold,funnel", strength: 1.8 },
    { content: "Mojo contact rate is 1 per 32 calls. One closing requires 6,734 calls", category: "funnel", keywords: "mojo,contact,rate", strength: 1.5 },
    { content: "Cold calling via Mojo is 36x more efficient per touch than TikTok", category: "business", keywords: "mojo,tiktok,efficiency", strength: 1.5 },
    { content: "Marco has an active listing at 1397 Canyon Lake — 3 bed 2 bath listed at $365,000", category: "listing", keywords: "canyon lake,listing,active", strength: 1.5 },
    { content: "Canyon Lake listing has had zero showings — likely overpriced and wrong lead photo", category: "listing", keywords: "canyon lake,showings,problem", strength: 1.5 },
    { content: "Marco targets buyers with $600k+ budget for new construction west of Stone Oak area in San Antonio", category: "market", keywords: "buyer,budget,stone oak,new construction", strength: 1.5 },
    { content: "VA loan buyers and first-time buyers are common lead types for Marco", category: "market", keywords: "VA loan,first time buyer,lead", strength: 1.2 },
    { content: "Carlos is Marco's VA who manages the CRM daily and handles most administrative tasks", category: "relationship", keywords: "carlos,va,crm", strength: 1.5 },
    { content: "Wesley goes out to do home tours for Marco to increase content output", category: "relationship", keywords: "wesley,content,tours", strength: 1.2 },
    { content: "Jahan at Aethon Intelligence built and manages Marco's automation system", category: "relationship", keywords: "jahan,aethon,developer", strength: 1.2 },
    { content: "Marco runs Instagram and TikTok DM automation — AI qualifies leads and captures phone numbers", category: "business", keywords: "dm,automation,leads", strength: 2.0 },
    { content: "Hot leads = phone captured in DMs but not yet texted via SMS on Twilio line", category: "business", keywords: "hot leads,sms,twilio", strength: 1.8 },
  ];

  const relations: [string, string, string, string, string][] = [
    ["Marco Puga", "person", "has_goal", "$20M by Nov 30 2026", "concept"],
    ["Marco Puga", "person", "runs", "TikTok buyer funnel", "concept"],
    ["Marco Puga", "person", "runs", "Mojo seller cold calling", "concept"],
    ["Marco Puga", "person", "listed", "1397 Canyon Lake", "project"],
    ["Marco Puga", "person", "works_with", "Carlos", "person"],
    ["Marco Puga", "person", "works_with", "Wesley", "person"],
    ["1397 Canyon Lake", "project", "problem", "zero showings", "concept"],
    ["TikTok funnel", "concept", "requires", "246227 views per closing", "concept"],
    ["Mojo funnel", "concept", "requires", "6734 calls per closing", "concept"],
  ];

  const procedures = [
    { trigger: "listing sits 30+ days with no showings", action: "Change lead photo, reduce price, rewrite MLS remarks, call prior showing agents", category: "listing" },
    { trigger: "lead goes cold for 30 days", action: "Re-engagement text fires automatically — check if they returned to website", category: "lead" },
    { trigger: "TikTok shows slow closing month", action: "Do not panic — TikTok closings lag 2-4 months from initial DM contact", category: "tiktok" },
    { trigger: "Marco asks about pace", action: "Check current videos per week vs 10.3 target and calls per day vs 725 target", category: "business" },
    { trigger: "buyer lead captured from Instagram or TikTok", action: "Get phone number within 2 messages, send property breakdown by end of day via SMS", category: "lead" },
    { trigger: "seller lead home goes off market", action: "Auto text asking if open to interviewing a qualified realtor in their area", category: "seller" },
  ];

  const insertRule = db.prepare(
    `INSERT INTO rules (id, trigger_condition, action, category, confidence, use_count, created_at, last_reinforced)
     VALUES (?, ?, ?, ?, 0.85, 0, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const s of semanticFacts) {
      insertFact.run(randomUUID(), s.content, s.category, s.keywords, s.strength, now, now);
    }
    for (const [aName, aType, rel, bName, bType] of relations) {
      const aId = upsertNode(aName, aType);
      const bId = upsertNode(bName, bType);
      db.prepare(
        `INSERT INTO edges (id, source_id, target_id, relationship, strength, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
      ).run(randomUUID(), aId, bId, rel, now, now);
    }
    for (const p of procedures) {
      insertRule.run(randomUUID(), p.trigger, p.action, p.category, now, now);
    }
    for (const dim of DIMENSIONS) {
      db.prepare(
        "INSERT OR IGNORE INTO identity_dimensions (dimension, confidence, updated_at) VALUES (?, 0.0, ?)",
      ).run(dim, now);
    }
  });

  tx();
  console.log("[hull/memory] Bootstrap complete");
}
