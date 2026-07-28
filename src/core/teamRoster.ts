/**
 * The team roster — who can log in, and where to email them.
 *
 * This list previously existed only as a `TEAM` array inside
 * public/team-tasks.html. It now lives here because three separate surfaces
 * need it: the Task Command board, the app shell's login gate, and the
 * assignment email. Duplicating it a third time would guarantee drift.
 *
 * Email addresses are deliberately NOT part of the public roster payload —
 * `GET /api/team/roster` serves `PublicTeamMember` (no address) because the
 * site currently runs with the login gate switched off (SITE_LOGIN_ENABLED),
 * so anything that endpoint returns is effectively public. Addresses are
 * read server-side only, at send time.
 *
 * Every address can be overridden without a deploy via TEAM_EMAIL_<ID>
 * (e.g. TEAM_EMAIL_CARLOS), which matters because these are personal
 * Gmail accounts that may change.
 */
import { getMarcoEmail } from "../integrations/gmail/index.js";

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  /** Avatar/accent colour — matches the Task Command board. */
  color: string;
  /**
   * Default inbox. Empty for Marco: he is the OAuth-linked sender, so his
   * address is resolved at send time from the Gmail profile itself
   * (see resolveTeamEmail) rather than hardcoded here.
   */
  email: string;
}

/** What the browser is allowed to see — no email addresses. */
export type PublicTeamMember = Omit<TeamMember, "email">;

const ROSTER: TeamMember[] = [
  { id: "marco", name: "Marco", role: "Lead Agent", color: "#7C3AED", email: "" },
  { id: "wesley", name: "Wesley", role: "Agent", color: "#0E7490", email: "wesleyodulin@gmail.com" },
  { id: "kendrick", name: "Kendrick", role: "Assistant", color: "#DB2777", email: "kendrick.acas4work.1@gmail.com" },
  { id: "carlos", name: "Carlos", role: "Assistant", color: "#A16207", email: "jamescarter.pugarealestate@gmail.com" },
];

const norm = (s: unknown) => String(s || "").toLowerCase().trim();

export function listTeamMembers(): PublicTeamMember[] {
  return ROSTER.map(({ id, name, role, color }) => ({ id, name, role, color }));
}

export function getTeamMember(id: string): TeamMember | undefined {
  const key = norm(id);
  return ROSTER.find((m) => m.id === key);
}

/** Display name for a member id, falling back to the raw id. */
export function teamMemberName(id: string): string {
  return getTeamMember(id)?.name || String(id || "").trim() || "A teammate";
}

/**
 * Where to actually email this member, or null if we have no address.
 *
 * Order: TEAM_EMAIL_<ID> env override → roster entry → for Marco only, the
 * OAuth-linked Gmail address (he is the sender, so assigning him a task
 * mails his own inbox). Returning null is a real outcome, not an error —
 * the caller logs it and the in-app notification still stands on its own.
 */
export function resolveTeamEmail(id: string): string | null {
  const member = getTeamMember(id);
  if (!member) return null;

  const override = process.env[`TEAM_EMAIL_${member.id.toUpperCase()}`]?.trim();
  if (override) return override;
  if (member.email) return member.email;
  if (member.id === "marco") return getMarcoEmail();
  return null;
}
