"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRedditIntel = runRedditIntel;
exports.saveRedditIntel = saveRedditIntel;
exports.getLatestRedditIntel = getLatestRedditIntel;
exports.getRedditQuestionSignals = getRedditQuestionSignals;
/**
 * Reddit intelligence — public, read-only JSON endpoints (no app/OAuth/account).
 *
 * Pulls top weekly posts from real-estate / first-time-buyer subreddits to feed
 * the Brain's Strategy/Recommendations as real buyer-question / content-gap
 * signals. Mirrors the youtube-intel pattern: fetch → cache in SQLite → read via
 * getLatestRedditIntel() → inject into prompts + buildContextSnapshot.
 *
 * No credentials: Reddit's /r/{sub}/top.json is public. It DOES require a real,
 * descriptive User-Agent (a generic/default UA gets rate-limited/blocked), so we
 * always send one. Requests are paced and cached daily to stay well-behaved.
 */
const axios_1 = __importDefault(require("axios"));
const contentDb_js_1 = require("../../core/contentDb.js");
const DEFAULT_SUBREDDITS = ["FirstTimeHomeBuyer", "RealEstate", "SanAntonio", "Mortgages", "RealEstateAdvice"];
const DEFAULT_UA = "ContentManagerBot/1.0 (Marco Puga Realty content manager)";
const CACHE_TTL_HOURS = 20; // daily-ish refresh
const REQUEST_DELAY_MS = 2000; // conservative pacing between subreddit calls
function subreddits() {
    const env = process.env.REDDIT_SUBREDDITS?.trim();
    if (env)
        return env.split(",").map((s) => s.trim().replace(/^r\//i, "")).filter(Boolean);
    return DEFAULT_SUBREDDITS;
}
function userAgent() {
    return process.env.REDDIT_USER_AGENT?.trim() || DEFAULT_UA;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchSubredditTop(sub) {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=week&limit=25`;
    const res = await axios_1.default.get(url, {
        headers: { "User-Agent": userAgent(), Accept: "application/json" },
        timeout: 15000,
    });
    const children = res.data?.data?.children || [];
    return children
        .map((c) => c.data)
        .filter((d) => Boolean(d) && !d.stickied)
        .map((d) => ({
        subreddit: sub,
        title: String(d.title || "").slice(0, 300),
        selftext: String(d.selftext || "").slice(0, 600),
        score: Number(d.score) || 0,
        numComments: Number(d.num_comments) || 0,
        permalink: `https://www.reddit.com${d.permalink || ""}`,
    }));
}
/**
 * Fetch + cache Reddit intel. Daily-cached; a total fetch failure leaves the
 * previous cache intact rather than wiping it. Never throws into the pipeline.
 */
async function runRedditIntel(force = false) {
    const cached = getLatestRedditIntel();
    if (!force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_HOURS * 3600 * 1000) {
        return cached;
    }
    const all = [];
    for (const sub of subreddits()) {
        try {
            const posts = await fetchSubredditTop(sub);
            all.push(...posts);
            console.log(`[reddit-intel] r/${sub}: ${posts.length} posts`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[reddit-intel] r/${sub} fetch failed: ${msg}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    if (!all.length) {
        console.warn("[reddit-intel] no posts fetched this run — keeping prior cache");
        return cached;
    }
    all.sort((a, b) => b.score - a.score);
    const intel = {
        fetchedAt: new Date().toISOString(),
        postCount: Math.min(all.length, 60),
        posts: all.slice(0, 60),
    };
    saveRedditIntel(intel);
    console.log(`[reddit-intel] cached ${intel.postCount} posts across ${subreddits().length} subreddits`);
    return intel;
}
function saveRedditIntel(intel) {
    try {
        (0, contentDb_js_1.getContentDb)()
            .prepare(`INSERT INTO cm_reddit_intel (fetched_at, post_count, posts_json) VALUES (?, ?, ?)`)
            .run(intel.fetchedAt, intel.postCount, JSON.stringify(intel.posts));
    }
    catch (err) {
        console.warn(`[reddit-intel] persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function getLatestRedditIntel() {
    try {
        const row = (0, contentDb_js_1.getContentDb)()
            .prepare(`SELECT fetched_at, post_count, posts_json FROM cm_reddit_intel ORDER BY fetched_at DESC LIMIT 1`)
            .get();
        if (!row)
            return null;
        return {
            fetchedAt: row.fetched_at,
            postCount: row.post_count,
            posts: JSON.parse(row.posts_json || "[]"),
        };
    }
    catch {
        return null;
    }
}
/**
 * Compact list of the top real buyer questions/topics for prompt injection —
 * favours question-shaped titles (the strongest content-gap signal).
 */
function getRedditQuestionSignals(limit = 12) {
    const intel = getLatestRedditIntel();
    if (!intel || !intel.posts.length)
        return [];
    const questionLike = intel.posts.filter((p) => /\?|\bhow\b|\bwhat\b|\bshould\b|\bcan i\b|\bis it\b|\bwhen\b|\bwhy\b|first[- ]?time/i.test(p.title));
    const chosen = (questionLike.length ? questionLike : intel.posts).slice(0, limit);
    return chosen.map((p) => `[r/${p.subreddit}, ${p.score}↑] ${p.title}`);
}
