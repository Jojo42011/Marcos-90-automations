"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSendingLine = resolveSendingLine;
/**
 * Resolve the line for a send.
 *
 * Pure and dependency-injected so the decision can be tested without Quo, an
 * environment, or a running server — this is the function that decides whose
 * name is on a message to a real client, and it should be provable.
 */
function resolveSendingLine(user, deps) {
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
            explain: "No sending line is configured. Assign this user a Quo number in Manage Team, " +
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
        explain: `${user.name} has no Quo line assigned, so this will go out on the account default` +
            `${defNum ? " (" + defNum + ")" : ""} — which is somebody else's number. ` +
            `Assign them a line in Manage Team.`,
    };
}
