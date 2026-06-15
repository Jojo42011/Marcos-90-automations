import type { Lead } from "../core/types.js";

/**
 * Extracts a usable first name for warm greetings.
 * Falls back gracefully if no real name is on file.
 */
export function getLeadFirstName(lead: Lead): string | null {
  if (lead.name) {
    const firstName = lead.name.trim().split(/\s+/)[0];
    if (
      firstName.length >= 2 &&
      !firstName.startsWith("@") &&
      !/^[^a-zA-Z]+$/.test(firstName)
    ) {
      return firstName;
    }
  }
  return null;
}
