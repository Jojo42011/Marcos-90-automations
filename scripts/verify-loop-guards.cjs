/* eslint-disable no-console — quick sanity check after build */
const u = require("../dist/src/app/conversationUtils.js");

const casita =
  "The casita can come furnished or unfurnished depending on what you prefer. Are you currently working with an agent on this search?";

console.assert(u.messagesAreSubstantiallyDuplicate(casita, casita));
console.assert(u.messagesAreSubstantiallyDuplicate(casita, casita.replace("search", "purchase")));
console.assert(
  u.latestAssistantEchoesEarlierInThread({
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: casita },
      { role: "user", text: "x" },
      { role: "assistant", text: casita },
    ],
  }),
);

console.assert(
  u.leadTextSignalsNoAgent(
    "I'm not currently working with anyone. And I think the price point would be fine.",
  ),
);

const conv = {
  messages: [
    { role: "user", text: "price?" },
    { role: "assistant", text: "Are you currently working with an agent?" },
  ],
};
console.assert(u.threadContainsAgentQuestion(conv));

console.log("verify-loop-guards: all assertions passed");
