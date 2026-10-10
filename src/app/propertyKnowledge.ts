/** Until a listing is linked, service area and conversation history are not listing facts. */
export function asksForListingFacts(text: string): boolean {
  return /\b(?:price|pricing|location|address|how much|what (?:city|area)|where (?:is|in|at)|bedrooms?|bathrooms?|square feet|sqft|acreage|builder|still available)\b/i.test(text)
    && !/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|buying process|closing costs|interest rate)\b/i.test(text);
}

export function unverifiedListingReply(hasPhone: boolean, previousReply = ""): string {
  const first = "Got you! I'll have someone reach out with the details on that house." +
    (hasPhone ? "" : " What's the best number to text you?");
  if (previousReply === first) return "I'll have someone follow up with you on that one." +
    (hasPhone ? "" : " Is there a good number they can reach you at?");
  return first;
}

/** The DM agent has no image/video understanding. Guard even stale model instructions. */
export function requestsUnsupportedPropertyMedia(reply: string): boolean {
  if (/\b(?:screenshots?|screen shots?)\b/i.test(reply)) return true;
  const media = /\b(?:photos?|pictures?|images?|videos?|clips?|reels?|listing links?)\b/i;
  return media.test(reply) && (
    /\b(?:send|share|upload|attach|forward|drop|provide|show)\b[^.!?]{0,100}\b(?:photos?|pictures?|images?|videos?|clips?|reels?|links?)\b/i.test(reply)
      && /\b(?:you|me|us|please|could|can|would|mind)\b/i.test(reply)
      && !/\b(?:I|we)(?:'ll| will| can) (?:send|share|show) you\b/i.test(reply)
    || /\b(?:I|we)\s+(?:(?:can|could|have|just|already)\s+|(?:have|just)\s+)?(?:see|saw|view|viewed|watch|watched|read|analyze|analyzed|recognize|tell from|look at|looked at)\b/i.test(reply)
  );
}

export function requestsPhoneNumber(text: string): boolean {
  return /\b(?:what(?:'s| is)|which)\b[^.!?]{0,70}\b(?:phone|number|digits)\b/i.test(text)
    || /\b(?:share|drop|provide|leave|give me|send me|text me)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text)
    || /\b(?:can|could|may) (?:i|we) (?:get|have)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text);
}
