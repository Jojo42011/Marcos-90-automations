/**
 * Who can be assigned a piece of content.
 *
 * The CRM has two overlapping people lists and the planner needs both:
 *
 *   teamRoster  — the four operators who log in and run the Task Command
 *                 board (Marco, Wesley, Kendrick, Carlos). They carry the
 *                 accent colours the rest of the app already uses for them.
 *   users.ts    — the CRM user table proper, which is where an account is
 *                 deactivated when someone is offboarded.
 *
 * Assigning from only one of them would either lose the accent colours or lose
 * the active/inactive state, so this merges them by name and prefers the
 * roster's colour. An offboarded person is NOT dropped: their name still has
 * to render on the content they were assigned, marked inactive, or the card
 * silently loses its owner.
 */
import { listTeamMembers } from "./teamRoster.js";
import { getUsers } from "./users.js";

export interface PlannerTeamMember {
  userId: string;
  fullName: string;
  role: string;
  accentColor: string;
  /** Initials, used as the avatar when there is no image. */
  avatarInitials: string;
  /** Null for everyone today — the CRM stores no photos. Wired for when it does. */
  avatarUrl: string | null;
  active: boolean;
  source: "roster" | "crm";
}

function initials(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const norm = (s: unknown) => String(s || "").toLowerCase().trim();

export function listPlannerTeam(): PlannerTeamMember[] {
  const out: PlannerTeamMember[] = [];
  const byName = new Map<string, PlannerTeamMember>();

  for (const m of listTeamMembers()) {
    const entry: PlannerTeamMember = {
      userId: m.id,
      fullName: m.name,
      role: m.role,
      accentColor: m.color,
      avatarInitials: initials(m.name),
      avatarUrl: null,
      active: true,
      source: "roster",
    };
    out.push(entry);
    byName.set(norm(m.name), entry);
  }

  let crmUsers: ReturnType<typeof getUsers> = [];
  try {
    crmUsers = getUsers();
  } catch {
    crmUsers = [];
  }
  for (const u of crmUsers) {
    const key = norm(u.name);
    const existing = byName.get(key);
    if (existing) {
      // Same person, two records. The CRM row is what knows they were
      // offboarded, so its active flag wins over the roster's assumption.
      if (u.active === false) existing.active = false;
      continue;
    }
    out.push({
      userId: u.id,
      fullName: u.name,
      role: u.role,
      accentColor: u.avatarColor || "#2dd4ee",
      avatarInitials: u.avatarInitials || initials(u.name),
      avatarUrl: null,
      active: u.active !== false,
      source: "crm",
    });
  }

  return out;
}

export function plannerMember(userId: string): PlannerTeamMember | null {
  const key = norm(userId);
  return listPlannerTeam().find((m) => norm(m.userId) === key) || null;
}

/** Display name for an id, with "(Inactive)" appended when they are offboarded. */
export function plannerMemberName(userId: string): string {
  const m = plannerMember(userId);
  if (!m) return userId;
  return m.active ? m.fullName : `${m.fullName} (Inactive)`;
}
