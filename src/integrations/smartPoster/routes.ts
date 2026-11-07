/**
 * SmartPoster HTTP routes — mounted from server.ts.
 */
import { randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import express from "express";
import path from "path";
import {
  deletePost,
  getDriveAuth,
  getPost,
  getSettings,
  listPosts,
  saveSettings,
  upsertPost,
} from "../../core/smartPosterStore.js";
import {
  disconnectDrive,
  finishDriveOAuth,
  googleOAuthConfigured,
  startDriveOAuth,
} from "./drive.js";
import { getSmartPosterOverview, runSmartPosterSync, schedulePostToZernio } from "./sync.js";

const oauthStates = new Map<string, { at: number }>();

function pruneStates(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of oauthStates) {
    if (v.at < cutoff) oauthStates.delete(k);
  }
}

export function registerSmartPosterRoutes(
  app: Express,
  opts: { publicDir: string; requireAuthPage: (req: Request, res: Response, next: () => void) => void },
): void {
  const { publicDir, requireAuthPage } = opts;

  app.get("/smartposter", requireAuthPage, (_req, res) => {
    res.sendFile(path.join(publicDir, "smartposter.html"));
  });

  app.get("/api/smartposter/overview", async (_req, res) => {
    try {
      res.json(await getSmartPosterOverview());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/posts", (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      res.json({
        posts: listPosts({
          status: status as never,
          from,
          to,
          limit: 300,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/smartposter/posts/:id", express.json({ limit: "200kb" }), (req, res) => {
    try {
      const post = getPost(String(req.params.id));
      if (!post) {
        res.status(404).json({ error: "Post not found" });
        return;
      }
      const b = (req.body || {}) as Record<string, unknown>;
      const next = upsertPost({
        ...post,
        title: b.title != null ? String(b.title) : post.title,
        caption: b.caption != null ? String(b.caption) : post.caption,
        scheduledFor:
          b.scheduledFor !== undefined
            ? b.scheduledFor
              ? String(b.scheduledFor)
              : null
            : post.scheduledFor,
        platforms: Array.isArray(b.platforms)
          ? (b.platforms as unknown[]).map((p) => String(p).toLowerCase())
          : post.platforms,
        status: b.status != null ? (String(b.status) as typeof post.status) : post.status,
      });
      res.json({ post: next });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/smartposter/posts/:id/schedule", async (req, res) => {
    try {
      const post = getPost(String(req.params.id));
      if (!post) {
        res.status(404).json({ error: "Post not found" });
        return;
      }
      const updated = await schedulePostToZernio(post);
      res.json({ post: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/smartposter/posts/:id", (req, res) => {
    try {
      const ok = deletePost(String(req.params.id));
      if (!ok) {
        res.status(404).json({ error: "Post not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/settings", (_req, res) => {
    res.json({
      settings: getSettings(),
      drive: getDriveAuth(),
      googleOAuthReady: googleOAuthConfigured(),
    });
  });

  app.patch("/api/smartposter/settings", express.json({ limit: "50kb" }), (req, res) => {
    try {
      const b = (req.body || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (b.driveFolderId != null) patch.driveFolderId = String(b.driveFolderId).trim();
      if (b.driveFolderName != null) patch.driveFolderName = String(b.driveFolderName).trim();
      if (b.timezone != null) patch.timezone = String(b.timezone).trim();
      if (Array.isArray(b.slots)) patch.slots = b.slots.map((s) => String(s));
      if (b.autoSchedule != null) patch.autoSchedule = Boolean(b.autoSchedule);
      if (b.ingestHour != null) patch.ingestHour = Number(b.ingestHour);
      const settings = saveSettings(patch as never);
      res.json({ settings });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/smartposter/sync", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const b = (req.body || {}) as Record<string, unknown>;
      const result = await runSmartPosterSync({
        date: b.date != null ? String(b.date) : undefined,
        forceSchedule: b.forceSchedule === true,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/drive/connect", (req, res) => {
    try {
      if (!googleOAuthConfigured()) {
        res.status(400).json({
          error:
            "Google Drive OAuth needs HARVEY_GOOGLE_CLIENT_ID, HARVEY_GOOGLE_CLIENT_SECRET, HARVEY_PUBLIC_URL, and HARVEY_VAULT_KEY.",
        });
        return;
      }
      pruneStates();
      const state = randomBytes(24).toString("hex");
      oauthStates.set(state, { at: Date.now() });
      const url = startDriveOAuth(state);
      if (req.query.redirect === "0") {
        res.json({ url });
        return;
      }
      res.redirect(url);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/drive/callback", async (req, res) => {
    try {
      const state = String(req.query.state || "");
      const code = String(req.query.code || "");
      const pending = oauthStates.get(state);
      oauthStates.delete(state);
      if (!code || !state || !pending) {
        res.status(400).send("Drive sign-in failed. Close this tab and try Connect Drive again.");
        return;
      }
      await finishDriveOAuth(code);
      res.redirect("/smartposter?drive=connected");
    } catch (err) {
      res
        .status(500)
        .send(`Drive sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.post("/api/smartposter/drive/disconnect", (_req, res) => {
    try {
      disconnectDrive();
      res.json({ ok: true, drive: getDriveAuth() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
