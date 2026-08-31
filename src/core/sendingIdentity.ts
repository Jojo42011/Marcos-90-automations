/**
 * Which phone line a message goes out on, and why.
 *
 * WHY THIS IS ITS OWN MODULE. Every text the CRM sends used to leave on one
 * global number (`QUO_PHONE_NUMBER_ID`). With Marco and Carlos on separate
 * lines that is actively wrong, not merely limited: a client who gets a text
 * from Carlos and replies goes to Carlos's phone, and if the CRM sent it under
 * Marco's number the reply lands with the wrong person — or worse, the client
 * saves the wrong number as "my realtor".
 *
 * So the choice of line is a decision with consequences, and it is made in one
 * place, returns WHY it chose, and is never silently guessed. The `reason` is
 * carried all the way back to the browser so the composer can show the operator
 * which line they are about to text from before they hit send.
 *
 * FALLING BACK IS DELIBERATE, NOT LAZY. A user with no assigned line falls back
 * to the account default rather than being refused: refusing would break
 * texting for every account that has one number and never needed this, which is
 * how it worked until now. But the fallback is reported as a fallback, so
 * "Carlos's texts are going out as Marco" is visible rather than silent.
 */
import type { CRMUser } from "./types.js";

export type SendingLineReason =
  /** The signed-in user has their own line assigned. */
  | "user_assigned"
  /** No line assigned to this user; using the account-wide default. */
  | "account_default"
  /** Nobody is signed in (a scheduled job, an automation); account default. */
  | "no_user"
  /** No line assigned AND no default configured — sending is not possible. */
  | "unconfigured";

export interface SendingLine {
  /** Quo's phone-number id, which is what the send API takes. */
  id: string | null;
  /** E.164, for display. Null when only an id is known. */
  number: string | null;
  reason: SendingLineReason;
  /** Who this line belongs to, for the UI. */
  userName: string | null;
  /** One sentence an operator can act on. */
  explain: string;
}

export interface SendingLineDeps {
  /** The account-wide default, i.e. QUO_PHONE_NUMBER_ID. */
  defaultId: string | null;
  /** The account-wide default as E.164, i.e. QUO_PHONE_NUMBER. */
  defaultNumber: string | null;
}

/**
 * Resolve the line for a send.
 *
 * Pure and dependency-injected so the decision can be tested without Quo, an
 * environment, or a running server — this is the function that decides whose
 * name is on a message to a real client, and it should be provable.
 */
export function resolveSendingLine(user: CRMUser | null, deps: SendingLineDeps): SendingLine {
  const assignedId = user?.quoPhoneNumberId?.trim() || "";
  const assignedNumber = user?.quoPhoneNumber?.trim() || "";

  if (assignedId) {
    return {
      id: assignedId,
      number: assignedNumber || null,
      reason: "user_assigned",
      userName: user?.name || null,
      explain: `Sending from ${assignedNumber || "the line assigned to " + (user?.name || "this user")}.`,
    };
  }

  const defId = deps.defaultId?.trim() || "";
  const defNum = deps.defaultNumber?.trim() || "";

  if (!defId && !defNum) {
    return {
      id: null,
      number: null,
      reason: "unconfigured",
      userName: null,
      explain:
        "No sending line is configured. Assign this user a Quo number in Manage Team, " +
        "or set QUO_PHONE_NUMBER_ID on the server.",
    };
  }

  if (!user) {
    return {
      id: defId || defNum, number: defNum || null, reason: "no_user", userName: null,
      explain: `Sent by an automation, so it uses the account's default line${defNum ? " (" + defNum + ")" : ""}.`,
    };
  }

  return {
    id: defId || defNum,
    number: defNum || null,
    reason: "account_default",
    userName: null,
    /* Named as a problem, because on a two-person account it is one: the
       message will be signed with somebody else's number. */
    explain:
      `${user.name} has no Quo line assigned, so this will go out on the account default` +
      `${defNum ? " (" + defNum + ")" : ""} — which is somebody else's number. ` +
      `Assign them a line in Manage Team.`,
  };
}
