// Marco Puga integration bridge.
//
// When the OpenReel editor is opened from Marco's Content Manager as
//   /editor/#/editor?clip=<clipId>&token=<dashboardToken>
// this module fetches that clip from the Marco backend (same-origin) and loads
// it straight onto the timeline, so the editor "starts from" the clip with no
// manual import. It is best-effort: if anything fails, the editor still opens
// empty and the user can import the downloaded clip by hand (the Content
// Manager modal keeps that fallback).
import { useProjectStore } from "./stores/project-store";

export interface MarcoClipParam {
  clipId: string;
  token: string;
}

/** Parse ?clip=&token= out of the hash (e.g. "#/editor?clip=abc&token=xyz"). */
export function getMarcoClipParam(): MarcoClipParam | null {
  try {
    const hash = window.location.hash || "";
    const qIndex = hash.indexOf("?");
    if (qIndex === -1) return null;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const clipId = params.get("clip");
    if (!clipId) return null;
    return { clipId, token: params.get("token") || "" };
  } catch {
    return null;
  }
}

// Guard so we only ever load once per tab, even if the effect re-runs.
let marcoLoadStarted = false;

/** Fetch the clip from the Marco backend and drop it on a fresh timeline. */
export async function autoLoadMarcoClip(clipId: string, token: string): Promise<void> {
  if (marcoLoadStarted) return;
  marcoLoadStarted = true;
  try {
    const url =
      `/api/content/clip/${encodeURIComponent(clipId)}/video` +
      (token ? `?token=${encodeURIComponent(token)}` : "");
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`clip fetch failed: HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], `marco-clip-${clipId}.mp4`, {
      type: blob.type || "video/mp4",
    });

    const imported = await useProjectStore.getState().importMedia(file);
    if (!imported.success || !imported.actionId) {
      throw new Error(imported.error?.message || "import failed");
    }
    await useProjectStore.getState().addClipToNewTrack(imported.actionId, 0);
    // eslint-disable-next-line no-console
    console.log("[marco] clip auto-loaded onto timeline:", clipId);
  } catch (err) {
    marcoLoadStarted = false; // allow a manual retry path if needed
    // eslint-disable-next-line no-console
    console.warn(
      "[marco] auto-load failed — import the downloaded clip manually instead:",
      err,
    );
  }
}
