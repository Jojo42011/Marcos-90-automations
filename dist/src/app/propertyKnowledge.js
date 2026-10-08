"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asksForListingFacts = asksForListingFacts;
exports.unverifiedListingReply = unverifiedListingReply;
exports.requestsPhoneNumber = requestsPhoneNumber;
/** Until a listing is linked, service area and conversation history are not listing facts. */
function asksForListingFacts(text) {
    return /\b(?:price|pricing|location|address|how much|what (?:city|area)|where (?:is|in|at)|bedrooms?|bathrooms?|square feet|sqft|acreage|builder|still available)\b/i.test(text)
        && !/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|buying process|closing costs|interest rate)\b/i.test(text);
}
function unverifiedListingReply(hasPhone) {
    return "I don't have verified details for that property yet, so I don't want to guess. " +
        (hasPhone ? "I have your number on file. Could you send the video or listing so we can confirm the right one?"
            : "Could you send the video or listing so we can confirm the right one?");
}
function requestsPhoneNumber(text) {
    return /\b(?:what(?:'s| is)|which)\b[^.!?]{0,70}\b(?:phone|number|digits)\b/i.test(text)
        || /\b(?:share|drop|provide|leave|give me|send me|text me)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text)
        || /\b(?:can|could|may) (?:i|we) (?:get|have)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text);
}
