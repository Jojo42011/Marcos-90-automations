"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLeadFirstName = getLeadFirstName;
/**
 * Extracts a usable first name for warm greetings.
 * Falls back gracefully if no real name is on file.
 */
function getLeadFirstName(lead) {
    if (lead.name) {
        const firstName = lead.name.trim().split(/\s+/)[0];
        if (firstName.length >= 2 &&
            !firstName.startsWith("@") &&
            !/^[^a-zA-Z]+$/.test(firstName)) {
            return firstName;
        }
    }
    return null;
}
