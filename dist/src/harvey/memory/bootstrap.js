"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapMemory = bootstrapMemory;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
function bootstrapMemory() {
    const db = (0, store_js_1.getMemoryDb)();
    const count = db.prepare("SELECT COUNT(*) as c FROM harvey_semantic").get().c;
    if (count > 0) {
        console.log("[Harvey Memory] Already bootstrapped with", count, "semantic memories");
        return;
    }
    console.log("[Harvey Memory] Bootstrapping initial memory...");
    const now = new Date().toISOString();
    const insertSemantic = db.prepare(`
    INSERT INTO harvey_semantic (id, fact, category, tags, confidence, access_count, last_accessed, created_at, weight)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
    const insertRelational = db.prepare(`
    INSERT INTO harvey_relational (id, entity_a, relationship, entity_b, weight, created_at, last_reinforced)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    const insertProcedural = db.prepare(`
    INSERT INTO harvey_procedural (id, trigger_condition, action, category, use_count, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `);
    const semanticFacts = [
        { fact: "Marco's $20M goal target date is November 30, 2026", category: "business", tags: "goal,20m,target", weight: 2.0 },
        { fact: "Marco has banked $5,956,520 across 14 deals — 29.8% of $20M goal", category: "funnel", tags: "goal,banked,production", weight: 2.0 },
        { fact: "Gap to $20M goal is $14,043,480 — needs 21 buyer closings and 14 seller closings", category: "funnel", tags: "goal,gap,closings", weight: 2.0 },
        { fact: "Average deal price is $425,466", category: "business", tags: "deal,price,average", weight: 1.5 },
        { fact: "Daily non-negotiables: 7 videos per day and 725 calls per day", category: "business", tags: "daily,target,videos,calls", weight: 2.0 },
        { fact: "TikTok funnel Dec 2025 to May 2026: 738,682 views, 4,076 comments, 3 closings across 124 videos", category: "funnel", tags: "tiktok,views,closings", weight: 1.8 },
        { fact: "TikTok average views per video is 5,957 with 28.7 second average watch time — above platform average of 17.5 seconds", category: "funnel", tags: "tiktok,watch,views", weight: 1.5 },
        { fact: "TikTok closing funnel: 246,227 views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 4 showings → 1 closing", category: "funnel", tags: "tiktok,funnel,conversion", weight: 1.8 },
        { fact: "At 5 videos per week Marco gets 1 closing every 8 weeks from TikTok. Needs 10.3 videos per week for monthly closings", category: "funnel", tags: "tiktok,pace,closing", weight: 1.8 },
        { fact: "Mojo dialer funnel Jan to May 2026: 26,938 calls → 846 contacts → 37 consults → 25 appointments → 8 agreements → 4 closings", category: "funnel", tags: "mojo,calls,cold,funnel", weight: 1.8 },
        { fact: "Mojo contact rate is 1 per 32 calls. One closing requires 6,734 calls", category: "funnel", tags: "mojo,contact,rate", weight: 1.5 },
        { fact: "Cold calling via Mojo is 36x more efficient per touch than TikTok", category: "business", tags: "mojo,tiktok,efficiency", weight: 1.5 },
        { fact: "Marco has an active listing at 1397 Canyon Lake — 3 bed 2 bath listed at $365,000", category: "listing", tags: "canyon lake,listing,active", weight: 1.5 },
        { fact: "Canyon Lake listing has had zero showings — likely overpriced and wrong lead photo", category: "listing", tags: "canyon lake,showings,problem", weight: 1.5 },
        { fact: "Marco targets buyers with $600k+ budget for new construction west of Stone Oak area in San Antonio", category: "market", tags: "buyer,budget,stone oak,new construction", weight: 1.5 },
        { fact: "VA loan buyers and first-time buyers are common lead types for Marco", category: "market", tags: "VA loan,first time buyer,lead", weight: 1.2 },
        { fact: "Carlos is Marco's VA who manages the CRM daily and handles most administrative tasks", category: "relationship", tags: "carlos,va,crm", weight: 1.5 },
        { fact: "Wesley goes out to do home tours for Marco to increase content output", category: "relationship", tags: "wesley,content,tours", weight: 1.2 },
        { fact: "Jahan at Aethon Intelligence built and manages Marco's automation system", category: "relationship", tags: "jahan,aethon,developer", weight: 1.2 },
    ];
    const relations = [
        ["Marco Puga", "has_goal", "$20M by Nov 30 2026"],
        ["Marco Puga", "runs", "TikTok buyer funnel"],
        ["Marco Puga", "runs", "Mojo seller cold calling"],
        ["Marco Puga", "listed", "1397 Canyon Lake"],
        ["Marco Puga", "targets", "Stone Oak new construction buyers"],
        ["Marco Puga", "works_with", "Carlos (VA)"],
        ["Marco Puga", "works_with", "Wesley (content)"],
        ["1397 Canyon Lake", "problem", "zero showings"],
        ["1397 Canyon Lake", "listed_at", "$365,000"],
        ["TikTok funnel", "requires", "246,227 views per closing"],
        ["Mojo funnel", "requires", "6,734 calls per closing"],
        ["Stone Oak", "is_a", "luxury new construction market"],
        ["Canyon Lake", "located_near", "San Antonio TX"],
    ];
    const procedures = [
        { trigger: "listing sits 30+ days with no showings", action: "Change lead photo, reduce price, rewrite MLS remarks, call prior showing agents", category: "listing" },
        { trigger: "lead goes cold for 30 days", action: "Re-engagement text fires automatically — check if they returned to website", category: "lead" },
        { trigger: "TikTok shows slow closing month", action: "Do not panic — TikTok closings lag 2-4 months from initial DM contact", category: "tiktok" },
        { trigger: "Marco asks about pace", action: "Check current videos per week vs 10.3 target and calls per day vs 725 target", category: "business" },
        { trigger: "buyer lead captured from Instagram or TikTok", action: "Get phone number within 2 messages, send property breakdown by end of day via SMS", category: "lead" },
        { trigger: "seller lead home goes off market", action: "Auto text asking if open to interviewing a qualified realtor in their area", category: "seller" },
    ];
    const insertAll = db.transaction(() => {
        for (const s of semanticFacts) {
            insertSemantic.run((0, crypto_1.randomUUID)(), s.fact, s.category, s.tags, 1.0, now, now, s.weight);
        }
        for (const [a, rel, b] of relations) {
            insertRelational.run((0, crypto_1.randomUUID)(), a, rel, b, 1.0, now, now);
        }
        for (const p of procedures) {
            insertProcedural.run((0, crypto_1.randomUUID)(), p.trigger, p.action, p.category, now);
        }
    });
    insertAll();
    console.log("[Harvey Memory] Bootstrap complete —", semanticFacts.length, "facts,", relations.length, "relations,", procedures.length, "procedures");
}
