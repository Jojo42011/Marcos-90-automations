"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveTeamTraining = saveTeamTraining;
exports.sharedTrainingContext = sharedTrainingContext;
const knowledgeStore_js_1 = require("../../core/knowledgeStore.js");
const learning_js_1 = require("./learning.js");
const users_js_1 = require("../../core/users.js");
function saveTeamTraining(owner, chatId, actorId, input) {
    const source = (0, learning_js_1.sourceMessage)(owner, chatId, Number(input.sourceSeq));
    const quote = (0, learning_js_1.safeNote)(input.sourceQuote, "Source quote", 600);
    if (source.role !== "user" || source.runId || source.origin || source.actorId && source.actorId !== actorId || !source.content.includes(quote))
        throw new Error("Team training needs a direct teaching quote from the current user");
    return (0, knowledgeStore_js_1.createDoc)({ title: (0, learning_js_1.safeNote)(input.title, "Training title", 150), body: (0, learning_js_1.safeNote)(input.value, "Training", 4000), category: "Harvey training", tags: ["harvey", "team-training"], updatedBy: (0, users_js_1.getAccountUserById)(actorId)?.name || actorId });
}
function sharedTrainingContext(query) {
    return (0, knowledgeStore_js_1.searchDocs)(query, 5).map(hit => ({ title: hit.title, excerpt: hit.excerpt }));
}
