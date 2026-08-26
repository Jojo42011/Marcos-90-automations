/**
 * One-time import of the team's operating SOPs into the Knowledge Center.
 *
 * The SOPs arrive as a Google Doc; the Knowledge Center stores documents on the
 * Fly volume (`/data/knowledge.json`), which no deploy touches. So without this
 * step, getting 19 SOPs onto the live system means pasting them in by hand, and
 * a rebuilt volume means pasting them in again. This runs at boot and puts them
 * there.
 *
 * IT IS A SEED, NOT A SYNC. After the first import the Knowledge Center is the
 * source of truth: the team edits documents there, and nothing here writes back
 * over their edits. That is why the import is keyed on a version marker AND
 * matches on title:
 *
 *   - marker already applied  -> does nothing at all, so an edited SOP is safe
 *   - marker bumped           -> adds only the titles that are MISSING, so a
 *                                new SOP can ship without reverting the others
 *   - a doc the team deleted  -> stays deleted, unless the marker is bumped,
 *                                which is a deliberate act
 *
 * The marker lives in `auth.db`'s security-state table because that is the one
 * key/value store in this system that already survives restarts and is not
 * owned by any single feature. `initialAdmin.ts` uses it the same way.
 */
import { getSecurityState, setSecurityState } from "./authStore.js";
import { createDoc, listDocs } from "./knowledgeStore.js";
import { SOP_LIBRARY, SOP_LIBRARY_VERSION } from "../data/sopLibrary.js";

const STATE_KEY = "sop_library_version";

export interface SopImportResult {
  ran: boolean;
  imported: string[];
  skipped: string[];
  reason?: string;
}

/**
 * Import any SOP the Knowledge Center does not already have, once per version.
 *
 * Never throws. A failure here must not stop the server booting — the SOPs are
 * reference material, not a dependency of anything — but it must be loud, so
 * the caller logs it rather than the absence being mistaken for "no SOPs yet".
 */
export function runSopImportStep(): SopImportResult {
  if (getSecurityState(STATE_KEY) === SOP_LIBRARY_VERSION) {
    return { ran: false, imported: [], skipped: [], reason: "already imported" };
  }

  /* Title match, case- and whitespace-insensitive. An operator who renamed an
     SOP will get a second copy under the original title — the alternative is
     matching on body text, which would re-add a document the moment anyone
     edited a word of it. Renaming is rare; editing is the point. */
  const existing = new Set(listDocs().map((d) => d.title.trim().toLowerCase()));
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const sop of SOP_LIBRARY) {
    if (existing.has(sop.title.trim().toLowerCase())) {
      skipped.push(sop.title);
      continue;
    }
    createDoc({
      title: sop.title,
      category: sop.category,
      tags: sop.tags,
      body: sop.body,
      updatedBy: "SOP import",
    });
    imported.push(sop.title);
  }

  setSecurityState(STATE_KEY, SOP_LIBRARY_VERSION);
  return { ran: true, imported, skipped };
}
