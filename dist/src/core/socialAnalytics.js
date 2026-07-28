"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tiktokMetrics = tiktokMetrics;
exports.getSocialAnalytics = getSocialAnalytics;
/**
 * 5 — Social analytics.
 *
 * One normalised shape per platform, plus a combined roll-up, so the UI can
 * render a tab per platform and an "All platforms" tab off the same data
 * without knowing where any of it came from.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a platform with no data source must
 * never be indistinguishable from a platform with genuinely zero engagement.
 * Every metric is `number | null` — null means "we don't know", 0 means "we
 * asked and the answer is zero" — and every platform carries a `status` and a
 * `source` saying where its numbers came from. The combined tab sums only
 * platforms that actually reported, and names the ones it left out, because a
 * total that silently omits Instagram is a lie by rounding.
 *
 * Today TikTok is real (Apify, via socialStore). The rest arrive when Zernio
 * is connected; until then they report `not_connected`.
 */
const socialStore_js_1 = require("./socialStore.js");
const index_js_1 = require("../integrations/zernio/index.js");
const STALE_AFTER_HOURS = 48;
/** Platforms the app claims to cover. TikTok is wired; the rest await Zernio. */
const ZERNIO_PLATFORMS = [
    { id: "instagram", label: "Instagram" },
    { id: "facebook", label: "Facebook" },
    { id: "youtube", label: "YouTube" },
];
function hoursSince(iso) {
    if (!iso)
        return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return null;
    return (Date.now() - t) / 3_600_000;
}
function engagement(likes, comments, shares, views) {
    if (views == null || views <= 0)
        return null;
    const interactions = (likes || 0) + (comments || 0) + (shares || 0);
    return Math.round((interactions / views) * 10000) / 100;
}
function emptyPlatform(id, label, note) {
    return {
        id, label,
        status: "not_connected",
        source: null,
        lastUpdated: null,
        stale: false,
        note,
        followers: null, posts: null, views: null, likes: null, comments: null, shares: null,
        avgViews: null, engagementRate: null, topPost: null, mix: null,
    };
}
/**
 * The most recent attempt to refresh TikTok, successful or not.
 *
 * Exists because "stale" on its own is a dead end. The nightly pull IS
 * scheduled and IS running — it had been failing every night for thirteen days
 * with Apify's "Monthly usage hard limit exceeded", and nothing anywhere said
 * so. The page told the operator to hit Refresh in Content Manager, which
 * could only ever fail the same way. A stale figure whose cause is invisible
 * sends someone to press a button that cannot work.
 */
function lastRefreshAttempt() {
    let pulls;
    try {
        pulls = (0, socialStore_js_1.getRecentAgentPulls)(40);
    }
    catch {
        return null;
    }
    const last = (pulls || []).find((p) => p.pullType === "social_refresh");
    if (!last)
        return null;
    return {
        at: last.pulledAt,
        ok: last.status === "success",
        detail: String(last.summary || "").replace(/^Failed:\s*/i, "").trim(),
    };
}
/** TikTok, from the existing Apify pull. This is the one live source today. */
function tiktokMetrics() {
    let data;
    try {
        data = (0, socialStore_js_1.getLatestSocialDashboardData)();
    }
    catch (err) {
        return {
            ...emptyPlatform("tiktok", "TikTok", `Couldn't read the TikTok store: ${err instanceof Error ? err.message : String(err)}`),
            status: "error",
        };
    }
    const s = data.summary;
    const hasAny = Boolean(data.lastUpdated) && (s.totalVideos > 0 || s.totalViews > 0);
    if (!hasAny) {
        return emptyPlatform("tiktok", "TikTok", "No TikTok pull has landed yet. Run a refresh from Content Manager to populate this.");
    }
    const age = hoursSince(data.lastUpdated);
    const top = data.videos && data.videos.length
        ? data.videos.reduce((a, b) => (b.views > a.views ? b : a))
        : null;
    /* A failing refresh outranks a plain "it's old" note: the age is the
       symptom, the failure is the thing someone can act on. */
    const attempt = lastRefreshAttempt();
    const attemptNewerThanData = attempt && (!data.lastUpdated || Date.parse(attempt.at) > Date.parse(data.lastUpdated));
    const stale = age != null && age > STALE_AFTER_HOURS;
    let note = null;
    if (attempt && !attempt.ok && attemptNewerThanData) {
        note =
            `The automatic refresh is running but FAILING — last tried ${attempt.at.slice(0, 16).replace("T", " ")} UTC: ` +
                `"${attempt.detail}". These numbers are frozen until that is fixed; pressing Refresh will hit the same error.`;
    }
    else if (stale) {
        note = `Last pulled ${Math.round(age / 24)} day(s) ago — refresh in Content Manager for current numbers.`;
    }
    return {
        id: "tiktok",
        label: "TikTok",
        status: "live",
        source: "Apify pull (Content Manager)",
        lastUpdated: data.lastUpdated,
        stale: stale || Boolean(attempt && !attempt.ok && attemptNewerThanData),
        note,
        refreshFailing: Boolean(attempt && !attempt.ok && attemptNewerThanData),
        lastAttempt: attempt,
        followers: data.snapshot?.followerCount ?? null,
        posts: s.totalVideos,
        views: s.totalViews,
        likes: s.totalLikes,
        comments: s.totalComments,
        shares: s.totalShares,
        avgViews: s.avgViews,
        engagementRate: engagement(s.totalLikes, s.totalComments, s.totalShares, s.totalViews),
        topPost: top
            ? { url: top.url || null, caption: top.caption || null, views: top.views ?? null }
            : data.snapshot?.topVideoUrl
                ? { url: data.snapshot.topVideoUrl, caption: data.snapshot.topVideoCaption, views: data.snapshot.topVideoViews }
                : null,
        mix: {
            viral: s.viralCount || 0,
            hot: s.hotCount || 0,
            average: s.averageCount || 0,
            cold: s.coldCount || 0,
        },
    };
}
/** One Zernio-backed platform. Never throws; a dead provider is a status. */
async function zernioMetrics(id, label) {
    if (!(0, index_js_1.isZernioConfigured)()) {
        return emptyPlatform(id, label, "Waiting on the Zernio connection — no data source for this platform yet.");
    }
    const r = await (0, index_js_1.fetchZernioPlatform)(id);
    if (!r.ok) {
        return { ...emptyPlatform(id, label, r.error || "Zernio request failed."), status: "error", source: "Zernio" };
    }
    if (r.unmapped) {
        return {
            ...emptyPlatform(id, label, "Zernio replied but none of its fields were recognised — the response mapping needs updating (see src/integrations/zernio)."),
            status: "unreadable",
            source: "Zernio",
        };
    }
    const st = r.stats;
    return {
        id, label,
        status: "live",
        source: "Zernio",
        lastUpdated: new Date().toISOString(),
        stale: false,
        note: null,
        followers: st.followers,
        posts: st.posts,
        views: st.views,
        likes: st.likes,
        comments: st.comments,
        shares: st.shares,
        avgViews: st.views != null && st.posts ? Math.round(st.views / st.posts) : null,
        engagementRate: engagement(st.likes, st.comments, st.shares, st.views),
        topPost: null,
        mix: null,
    };
}
/**
 * Roll every platform into one view.
 *
 * Only `live` platforms are summed. Everything skipped is listed in
 * `excluded` with its reason so the UI can say plainly what the total does and
 * doesn't cover — "1.2M views across TikTok only" is useful; "1.2M views"
 * implying all channels is not.
 */
function combine(platforms) {
    const live = platforms.filter((p) => p.status === "live");
    const excluded = platforms
        .filter((p) => p.status !== "live")
        .map((p) => ({ label: p.label, reason: p.note || "No data." }));
    const sum = (pick) => {
        const vals = live.map(pick).filter((v) => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const views = sum((p) => p.views);
    const likes = sum((p) => p.likes);
    const comments = sum((p) => p.comments);
    const shares = sum((p) => p.shares);
    const posts = sum((p) => p.posts);
    let top = null;
    for (const p of live) {
        if (p.topPost && p.topPost.views != null && (!top || top.views == null || p.topPost.views > top.views)) {
            top = { ...p.topPost, platform: p.label };
        }
    }
    const oldest = live
        .map((p) => p.lastUpdated)
        .filter((d) => Boolean(d))
        .sort()[0] || null;
    return {
        id: "all",
        label: "All platforms",
        status: live.length ? "live" : "not_connected",
        source: live.length ? live.map((p) => p.label).join(" + ") : null,
        lastUpdated: oldest,
        stale: live.some((p) => p.stale),
        note: live.length
            ? excluded.length
                ? `Totals cover ${live.map((p) => p.label).join(", ")} only. ${excluded.map((e) => e.label).join(", ")} ${excluded.length === 1 ? "is" : "are"} not included.`
                : null
            : "No platform is reporting yet, so there is nothing to roll up.",
        followers: sum((p) => p.followers),
        posts,
        views,
        likes,
        comments,
        shares,
        avgViews: views != null && posts ? Math.round(views / posts) : null,
        engagementRate: engagement(likes, comments, shares, views),
        included: live.map((p) => p.label),
        excluded,
        topPost: top,
    };
}
async function getSocialAnalytics() {
    const others = await Promise.all(ZERNIO_PLATFORMS.map((p) => zernioMetrics(p.id, p.label)));
    const platforms = [tiktokMetrics(), ...others];
    return {
        platforms,
        combined: combine(platforms),
        zernio: { configured: (0, index_js_1.isZernioConfigured)() },
        generatedAt: new Date().toISOString(),
    };
}
