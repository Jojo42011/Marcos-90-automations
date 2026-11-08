/**
 * SmartPoster HTTP routes — mounted from server.ts.
 * Drive connect uses Composio (same managed OAuth as Harvey Plugins).
 */
import type { Express, Request, Response } from "express";
import express from "express";
import path from "path";
import { tenantOwner } from "../../core/tenantData.js";
import {
  deletePost,
  getPost,
  getSettings,
  listPosts,
  saveSettings,
} from "../../core/smartPosterStore.js";
import {
  disconnectComposioDrive,
  getComposioDriveStatus,
  searchDriveFolders,
  startComposioDriveConnect,
} from "./drive.js";
import { getSmartPosterOverview, runSmartPosterSync, updateSmartPosterPost, isPostBusy } from "./sync.js";

type SessionUser = (req: Request) => { id?: string } | null;

function ownerOf(req: Request, sessionUser?: SessionUser): string {
  return String(tenantOwner() || sessionUser?.(req)?.id || "operator");
}

export function registerSmartPosterRoutes(
  app: Express,
  opts: {
    publicDir: string;
    requireAuthPage: (req: Request, res: Response, next: () => void) => void;
    sessionUser?: SessionUser;
  },
): void {
  const { publicDir, requireAuthPage, sessionUser } = opts;

  app.get("/smartposter", requireAuthPage, (_req, res) => {
    res.sendFile(path.join(publicDir, "smartposter.html"));
  });

  app.get("/api/smartposter/overview", async (req, res) => {
    try {
      res.json(await getSmartPosterOverview(ownerOf(req, sessionUser)));
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

  app.patch("/api/smartposter/posts/:id", express.json({ limit: "200kb" }), async (req, res) => {
    try {
      if (!getPost(String(req.params.id))) { res.status(404).json({error:"Post not found"}); return; }
      res.json({post: await updateSmartPosterPost(String(req.params.id), req.body || {})});
    } catch (err) { res.status(400).json({error:err instanceof Error ? err.message : String(err)}); }
  });

  app.post("/api/smartposter/posts/:id/schedule", express.json({ limit: "200kb" }), async (req, res) => {
    try {
      if (!getPost(String(req.params.id))) { res.status(404).json({error:"Post not found"}); return; }
      const post = await updateSmartPosterPost(String(req.params.id), req.body || {}, true, ownerOf(req, sessionUser));
      if (post.status === "scheduled" && !post.zernioPostId) { res.status(409).json({error:post.error,post}); return; }
      if (post.status === "failed") { res.status(400).json({error:post.error,post}); return; }
      res.json({post});
    } catch (err) { res.status(400).json({error:err instanceof Error ? err.message : String(err)}); }
  });

  app.delete("/api/smartposter/posts/:id", (req, res) => {
    try {
      const existing = getPost(String(req.params.id));
      if (isPostBusy(String(req.params.id)) || existing?.zernioPostId || existing?.status === "scheduled" || existing?.status === "published") {
        res.status(409).json({error:"Manage scheduled or published posts in Zernio before removing their local records."}); return;
      }
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

  app.get("/api/smartposter/settings", async (req, res) => {
    try {
      const owner = ownerOf(req, sessionUser);
      res.json({
        settings: getSettings(),
        drive: await getComposioDriveStatus(owner),
        composioReady: (await getComposioDriveStatus(owner)).ready,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/smartposter/settings", express.json({ limit: "50kb" }), (req, res) => {
    try {
      const b = (req.body || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (b.driveFolderName != null) {
        patch.driveFolderName = String(b.driveFolderName).trim();
        /* Changing the name invalidates a prior cached id unless a new id is sent. */
        if (b.driveFolderId == null) patch.driveFolderId = "";
      }
      if (b.driveFolderId != null) patch.driveFolderId = String(b.driveFolderId).trim();
      if (b.timezone != null) patch.timezone = String(b.timezone).trim();
      if (Array.isArray(b.slots)) patch.slots = b.slots.map((s) => String(s));
      if (b.autoSchedule != null) patch.autoSchedule = Boolean(b.autoSchedule);
      if (b.ingestIntervalMinutes != null) patch.ingestIntervalMinutes = Number(b.ingestIntervalMinutes);
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
        owner: ownerOf(req, sessionUser),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/drive/connect", async (req, res) => {
    try {
      const { url } = await startComposioDriveConnect(ownerOf(req, sessionUser));
      if (req.query.redirect === "0") {
        res.json({ url });
        return;
      }
      res.redirect(url);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/smartposter/drive/disconnect", async (req, res) => {
    try {
      const owner = ownerOf(req, sessionUser);
      await disconnectComposioDrive(owner);
      res.json({ ok: true, drive: await getComposioDriveStatus(owner) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/smartposter/drive/folders", async (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const folders = await searchDriveFolders(ownerOf(req, sessionUser), q);
      res.json({ folders });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
