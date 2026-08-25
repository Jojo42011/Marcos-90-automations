"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initVocabularySchema = initVocabularySchema;
exports.listVocabulary = listVocabulary;
exports.addVocabulary = addVocabulary;
exports.removeVocabulary = removeVocabulary;
exports.vocabularyStats = vocabularyStats;
/**
 * The managed Source and Tag lists — one vocabulary for Filter Leads, the Add
 * Agreement form, and anything else that has to ask "where did this contact
 * come from?".
 *
 * WHY THIS FILE EXISTS. Until now both dropdowns were built from `DISTINCT` over
 * whatever was already recorded on the contacts. That is fine for reading the
 * data back and useless for entering it: a source Marco has not used yet cannot
 * be picked, so it gets typed freehand, and "Zillow", "zillow" and "Zillow.com"
 * become three sources. The seeded lists below are the real Brivity export —
 * every source and tag from the account being migrated off, with the number of
 * people carrying it at export time.
 *
 * THE COUNTS ARE A SNAPSHOT, NOT LIVE. They are what Brivity reported on
 * 2026-08-25 and they are shown as such ("1,062 in Brivity"), because the useful
 * thing about them is which entries are real working sources and which are
 * catalogue filler — 329 of the 357 sources had nobody on them. They are never
 * added to, and never used as this system's own count of anything.
 *
 * Custom entries live in `/data/crm-vocabulary.db` rather than in this file, so
 * adding a source is an operator action and not a deploy.
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** Sources exactly as exported from Brivity on 2026-08-25: `[name, people]`. */
const SEED_SOURCES = [
    ["2x Referrals", 5], ["33 Touch", 0], ["55Places.com", 0], ["800 Number", 0], ["AI", 0], ["ActiveRain", 0],
    ["AdRoll", 0], ["AdWerx", 0], ["Affiliate", 1], ["Agent Harvest", 0], ["Agent Jet", 0], ["Agent Lead", 0],
    ["Agent Machine", 0], ["Agent Pronto", 0], ["Agent Referral", 0], ["Agent Site", 0], ["AgentMachine", 0],
    ["AgentMarketing.com - text4info", 0], ["Agentology", 0], ["Allied Partner", 0], ["Alt Lead Referral", 0],
    ["Altisource", 0], ["Altos Research", 0], ["Anchor Wave", 0], ["AnswerConnect", 0], ["Api", 0],
    ["ArchAgent.com", 0], ["AreaPro", 0], ["Ask.com", 0], ["Auction.com", 1], ["Automabots", 0], ["Avendale NC", 0],
    ["BackPage.com", 0], ["Bank of America", 0], ["Barbara Corcoran", 0], ["Billboard", 0], ["Bing", 0],
    ["Bing.com Organic", 0], ["Bing.com PPC", 0], ["Blog", 0], ["Blossor", 0], ["BoldLeads.com", 0], ["BombBomb", 0],
    ["BoomTown", 0], ["Brivity", 0], ["Brivity CMA", 0], ["Brivity Connect", 0], ["Brivity Facebook Ads", 0],
    ["Brivity Home", 0], ["Brivity IDX", 67], ["Brivity Leads", 0], ["Brivity Marketer", 0],
    ["Brivity Marketer Ad", 0], ["Brivity Showing Request", 0], ["Brivity Valuations", 0], ["Broker Referral", 1],
    ["Broker Site", 0], ["Builder Lead", 0], ["Business Networking International", 0], ["Business Partner", 0],
    ["CMT.com", 0], ["CRS Referral Network", 0], ["CU REALTY", 0], ["Cactus", 0], ["Call Capture", 0],
    ["Call Center", 0], ["Call In", 321], ["Canceled Listing", 0], ["Cancelled / Expired", 244],
    ["Carrington Connects", 0], ["Cartus", 0], ["Century 21", 0], ["Chalk Digital", 0], ["Chase", 0], ["Chat", 0],
    ["ChatGPT", 0], ["Circle Pix", 0], ["Circle Prospecting", 7], ["Citywide", 0], ["Client Referral", 2],
    ["CloudCMA.com", 0], ["Cold Call", 1], ["ComF5 Email", 0], ["Commissions Inc", 0], ["CommissionsInc.com", 0],
    ["Company Event", 0], ["Company Generated Lead", 0], ["Condo.com", 0], ["Constant Contact", 0],
    ["Contest Lead", 0], ["Corefact", 0], ["Craigslist", 0], ["DRMoves.com", 0], ["Dave Ramsey", 0],
    ["Development", 0], ["Distressed Ad", 0], ["Diverse Solutions", 0], ["Door Knocking", 0], ["DownPayment.org", 0],
    ["ELP", 0], ["Ebay Classifieds", 0], ["Email Signature", 0], ["Endorsed Local Providers", 0], ["Estately", 0],
    ["Eventbrite", 1], ["Expired", 1], ["FB Ninja Ads", 0], ["FHO", 0], ["FSBO", 0], ["Facebook", 0],
    ["Facebook - (Non BT Paid)", 0], ["Facebook-Volcano", 0], ["Farm", 0], ["Fast Expert", 0],
    ["FastHomeOffer.com", 0], ["First2Contact.com", 0], ["Flex", 0], ["Flyer", 0], ["Follow-Up Boss", 0],
    ["Foursquare", 0], ["FreeHouseValues.com", 0], ["Friend or Family", 0], ["GeographicFarm.com", 0],
    ["Glenn Beck", 0], ["Google", 0], ["Google Organic", 0], ["Google PPC", 0], ["Google+", 0], ["GoogleAdSpace", 0],
    ["Guaranteed Sale", 0], ["HBN", 0], ["Happy Hour", 0], ["Home Buying Seminar", 0], ["Home Show", 0],
    ["Home Value Leads", 0], ["HomeGain", 0], ["HomeLight", 0], ["HomeLoanIQ", 0], ["HomePath", 0], ["HomeSearch", 0],
    ["HomeSnap.com", 0], ["Homebidz", 0], ["Homes and Land", 0], ["Homes.com", 0], ["Hot Homes", 0],
    ["HotPads Syndication", 0], ["HouseHunt", 0], ["HouseValues.com", 0], ["Hub", 0], ["HubSpot.com", 0], ["Hubzu", 0],
    ["IDXBroker.com", 0], ["IVR", 0], ["Import", 1], ["Imprev", 0], ["Inbound", 54], ["Inside Sales", 0],
    ["Instagram", 80], ["Internet Engine", 0], ["Investability", 0], ["Just Listed Postcard", 0],
    ["Just Sold Postcard", 0], ["JustListed.com", 0], ["Juwai", 0], ["Kahping", 0], ["Keller Williams", 0],
    ["Keller Williams kw.com", 0], ["Kiosk", 0], ["Kunversion", 0], ["Kwkly", 0], ["LandWatch", 0], ["Lead Router", 0],
    ["Lead Team", 0], ["LeadMX", 0], ["LeadQual", 0], ["Lender Lead", 1], ["Less Than 6 Percent", 0],
    ["LinkedIn.com", 0], ["ListHub", 0], ["Listing Booster", 0], ["Listing Grabber", 2], ["Listing Lead", 3],
    ["Listing Pages", 0], ["Listingbook", 0], ["Listings-2-Leads", 0], ["Live City Guide", 0], ["Local Citations", 0],
    ["Local Zine", 0], ["Loopnet", 0], ["MLS Finder", 0], ["Magazine", 0], ["MailChimp", 0], ["Mailing List", 0],
    ["Market Leader", 0], ["Market Snapshot", 0], ["Megastar", 0], ["Mobile App", 0], ["MobilityRE", 0],
    ["Model Home", 0], ["Mojo", 445], ["Mojo FL", 102], ["Movoto", 0], ["Nat'l Mortgage Forgiveness Plan", 0],
    ["Native Rank", 0], ["New Construction", 0], ["New Home Builder", 0], ["Newcomer Report", 0], ["Newsletter", 0],
    ["Newspaper", 0], ["Nextdoor", 0], ["Niche Magazine", 0], ["No Source", 0], ["Number1Expert.com", 0],
    ["Offrs.com", 0], ["Open House", 4], ["Opportunities - Expired", 0], ["Opportunities - FSBO", 0],
    ["Opportunities - Preforeclosure", 0], ["Orphan Client", 0], ["Other", 37], ["Other Website", 1],
    ["Out of Area Owners", 0], ["Outbound Call", 0], ["Outside Agent Referral", 0], ["PSL", 0],
    ["Partner Network", 0], ["Past Client", 0], ["Personal", 0], ["Phone Animal", 0], ["Pinterest", 0],
    ["Platform Real Estate", 0], ["Point2 Agent", 0], ["PostHousing", 0], ["Postcards / Mailer", 0],
    ["Prime Seller Leads", 0], ["ProAgent.com", 0], ["ProQuest", 0], ["Probate", 0], ["Professional", 0],
    ["Properties Online", 0], ["Property Management", 0], ["Prospecting", 0], ["QR Code", 0], ["Qazzoo", 0],
    ["Quantum Digital", 0], ["Quicken Loans", 0], ["RE/MAX", 0], ["REW.ca", 0], ["Radio", 0], ["Rally Pages", 0],
    ["ReadyChat", 0], ["Real Agent Pros", 0], ["Real Estate Book", 0], ["Real Estate Owned", 0],
    ["Real Estate Webmasters", 0], ["Real Geeks", 0], ["Real Leads", 0], ["RealEstate.com", 0],
    ["RealEstateAgentsITrust.com", 0], ["RealEstateBook.com", 0], ["RealEstatePipeline.com", 0],
    ["RealProSystems.com", 0], ["Realbird.com", 0], ["Realtor.com", 0], ["RealtyNow", 0], ["RealtyTrac", 0],
    ["Recruiter.ai", 0], ["Recruiting", 0], ["Redfin", 0], ["Referral", 0], ["Referring Website Redirect/Forward", 0],
    ["Relocation", 0], ["Rental Lead", 1], ["Repeat Business", 0], ["Reply.com", 0], ["Seize the Market", 0],
    ["Seminar", 0], ["Short Sale", 0], ["Sierra Interactive", 0], ["Sign Call", 0], ["Sign Flyer", 0], ["SmartZip", 0],
    ["Sotheby's International Realty", 0], ["Spacio", 0], ["Sphere Of Influence", 56], ["Sphere Referral", 7],
    ["Street Text", 0], ["THST", 0], ["TIGERLEADS", 0], ["TITLE_COMPANY", 0], ["TV", 0], ["Team Lead", 0],
    ["Team Referral", 0], ["Tele-Home", 0], ["Telemarketer", 0], ["Text Rider Lead", 0], ["Thrive.us", 0],
    ["TikTok", 359], ["Top Agent Choice", 0], ["Top Agent Locator", 0], ["Top Marketer", 0], ["Top Producer", 0],
    ["Tour Factory", 0], ["Tour of Homes", 0], ["Trade Show", 0], ["Trade Up", 0], ["Transaction Client", 0],
    ["Transaction Collaborator", 0], ["Trulia", 0], ["Twitter", 0], ["USAA", 0], ["USDA Seminar", 0],
    ["USHUD Form", 0], ["Unknown Source", 0], ["UpNest", 0], ["VB&S", 0], ["VB&S Listing", 0], ["VIDEO", 0],
    ["Vende Social", 0], ["Virtual Assistant", 0], ["Virtual Open House", 0], ["Virtual Tour", 0], ["Vulcan", 0],
    ["Vyral Marketing", 0], ["WAZE", 0], ["WHATSMYHOMEWORTH", 0], ["WUFOO", 0], ["Walk In", 0],
    ["Web Agent Solutions", 0], ["Wedding Show", 0], ["Whats My Home Worth", 0], ["Window Flyers", 0], ["Wix.com", 0],
    ["Xome", 0], ["Yahoo", 0], ["Yard Sign", 0], ["Yellow Pages", 0], ["Yelp", 0], ["Ylopo", 0], ["YouTube.com", 0],
    ["Zapier", 0], ["Zillow", 1], ["ZipLeads", 0], ["Zopim", 0], ["Zurple", 0], ["apartmentlist.com", 0],
    ["buzzbuzzhome.com", 0], ["e-Newsletter", 0], ["eEdge", 0], ["experthomeoffers.com", 0],
    ["homesforheroes.com", 0], ["housevaluestore.com", 0], ["leadstoday.com", 0], ["lifestyledlistings.com", 0],
    ["realtystore.com", 0], ["voicepad.com", 0], ["zBuyer.com", 0]
];
/** Tags exactly as exported from Brivity on 2026-08-25: `[name, people]`. */
const SEED_TAGS = [
    ["10/27/25 Brivity Import", 1062], ["12518 yellowstone", 1], ["1397 Canyon Lake", 9], ["246 Quentin", 9],
    ["55 log cabin way", 20], ["602 Indigo", 3], ["616 Green Oak", 8], ["6.25%", 1], ["885 Brushy Creek", 1],
    ["ai-journey", 1], ["ai-status-active-drip", 1], ["appointment", 1], ["Appointment", 9], ["Bandera", 0],
    ["Boerne", 0], ["Bulverde", 0], ["BUYER 2025", 1], ["Canyon Lake", 4], ["Castroville", 0],
    ["Contact - said no", 66], ["contact_signup", 22], ["Converse", 0], ["DFW", 1], ["Events", 2], ["Expired", 2],
    ["Expired - Hot", 133], ["Expired - nurture", 108], ["Expired - Watch", 103], ["FHA", 1], ["FL lead", 1],
    ["Future Follow Up", 1], ["Garden Ridge", 0], ["Has Agent - No", 3], ["Has closing date", 5], ["Helotes", 6],
    ["homevalue", 4], ["Home Value", 3], ["HOME VALUE", 7], ["IDX Chat", 6], ["instagram", 36], ["Investor", 3],
    ["Marco", 38], ["Marco Puga's Leads", 22], ["Marco's Leads", 1], ["Matthew Garcia Lender", 1], ["MISC Lender", 1],
    ["Mojo FL", 52], ["M/X", 1], ["New Braunfels", 9], ["Open House", 3], ["openhouseapp", 3], ["Past Clients", 2],
    ["Pipe Creek", 0], ["P/L", 1], ["Postcard", 2], ["Poteet", 1], ["Production - $0-2M", 0],
    ["Production - $15M+", 0], ["Production - $2-4M", 0], ["Production - $4-8M", 0], ["Production - $8-15M", 0],
    ["Production Contest", 1], ["Production Contest 2025", 1], ["sales rep", 1], ["San Antonio", 59], ["Schertz", 6],
    ["Seguin", 0], ["SELLER 2025", 1], ["SMS Marketing Opt Out", 3], ["SMS Opt In", 7], ["SMS Opt Out", 3],
    ["spanish", 1], ["Sphere A", 0], ["Sphere A+", 0], ["Sphere B", 0], ["Sphere C", 0], ["Sphere Of Influence", 22],
    ["Spring Branch", 0], ["tiktok", 120], ["VIP", 2], ["weekly email", 7]
];
/* ---- the store for anything added after the migration --------------------- */
const DB_PATH = process.env.CRM_VOCAB_DB_PATH ||
    node_path_1.default.join(process.env.DATA_DIR || "/data", "crm-vocabulary.db");
let db = null;
function getDb() {
    if (db)
        return db;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(DB_PATH), { recursive: true });
    db = new better_sqlite3_1.default(DB_PATH);
    db.pragma("journal_mode = WAL");
    initVocabularySchema(db);
    return db;
}
function initVocabularySchema(target) {
    const d = target || getDb();
    /* `kind` rather than two tables: sources and tags are the same shape, and one
       table means one place to add "appointment outcomes" the day that list also
       needs to be editable. `name_key` is the lowercased name and carries the
       uniqueness, so "Open House" cannot be added twice as "open house". */
    d.exec(`
    CREATE TABLE IF NOT EXISTS crm_vocabulary (
      kind       TEXT NOT NULL,
      name_key   TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (kind, name_key)
    );
  `);
}
const SEEDS = {
    source: SEED_SOURCES,
    tag: SEED_TAGS,
};
/**
 * The full list for a kind: the Brivity export plus anything added here,
 * merged case-insensitively and sorted the way a person reads a dropdown.
 *
 * Sorted with `localeCompare` and numeric collation so "2x Referrals" and
 * "55Places.com" land where a person would look for them rather than where
 * ASCII puts them.
 */
function listVocabulary(kind) {
    /* Seeded entries are keyed by their EXACT name, not a lowercased one.
       Brivity's export really does contain both "Appointment" (9 people) and
       "appointment" (1), and they are two different tags on two different sets of
       contacts — the filter matches tags exactly, so folding them together here
       would offer one option that silently misses the other spelling's people.
       Case-folding is only used below, to stop someone ADDING a duplicate. */
    const byKey = new Map();
    for (const [name, people] of SEEDS[kind]) {
        byKey.set(name, { name, brivityPeople: people, seeded: true });
    }
    const seededKeys = new Set([...byKey.keys()].map((k) => k.toLowerCase()));
    let custom = [];
    try {
        custom = getDb().prepare(`SELECT name FROM crm_vocabulary WHERE kind = ? ORDER BY name`).all(kind);
    }
    catch (err) {
        /* A vocabulary read must never take a page down: the seeded list alone is
           still a working dropdown. */
        console.warn("[crmVocabulary] custom entries unavailable:", err);
    }
    for (const c of custom) {
        /* A custom entry that duplicates a seeded one keeps the seeded record —
           otherwise re-adding "Zillow" would quietly drop its export count. */
        if (!seededKeys.has(c.name.toLowerCase()))
            byKey.set(c.name, { name: c.name, brivityPeople: null, seeded: false });
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
}
/** Add a custom entry. Returns the stored name, or null if it already exists. */
function addVocabulary(kind, rawName, createdBy) {
    const name = String(rawName || "").trim();
    if (!name)
        return null;
    if (name.length > 80)
        return null;
    const key = name.toLowerCase();
    if (SEEDS[kind].some(([n]) => n.toLowerCase() === key))
        return null;
    const info = getDb()
        .prepare(`INSERT OR IGNORE INTO crm_vocabulary (kind, name_key, name, created_at, created_by)
              VALUES (?, ?, ?, ?, ?)`)
        .run(kind, key, name, new Date().toISOString(), createdBy || null);
    return info.changes ? name : null;
}
/**
 * Remove a custom entry. Seeded entries cannot be removed — they describe what
 * was imported, and hiding one would not un-tag the contacts carrying it.
 */
function removeVocabulary(kind, rawName) {
    const key = String(rawName || "").trim().toLowerCase();
    if (!key)
        return false;
    if (SEEDS[kind].some(([n]) => n.toLowerCase() === key))
        return false;
    return getDb().prepare(`DELETE FROM crm_vocabulary WHERE kind = ? AND name_key = ?`).run(kind, key).changes > 0;
}
/** Seeded counts, for the "what did we import" line. */
function vocabularyStats() {
    return {
        sources: SEED_SOURCES.length,
        tags: SEED_TAGS.length,
        sourcesInBrivity: SEED_SOURCES.filter(([, n]) => n > 0).length,
        tagsInBrivity: SEED_TAGS.filter(([, n]) => n > 0).length,
    };
}
