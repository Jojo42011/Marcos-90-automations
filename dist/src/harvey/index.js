"use strict";
/**
 * Harvey operator pipeline: perception → judgment → communication.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHarveyModel = void 0;
exports.runHarveyOps = runHarveyOps;
exports.runHarveyChat = runHarveyChat;
const perception_js_1 = require("./perception.js");
const judgment_js_1 = require("./judgment.js");
const memory_js_1 = require("./memory.js");
const communication_js_1 = require("./communication.js");
async function runHarveyOps(deps) {
    const context = await (0, perception_js_1.buildHarveyContext)(deps);
    const judgment = (0, judgment_js_1.runJudgment)(context, "");
    return {
        context,
        judgment,
        metrics: (0, perception_js_1.contextToMetricsPanel)(context),
    };
}
async function runHarveyChat(input) {
    const sessionId = (0, memory_js_1.getOrCreateSessionId)(input.sessionId);
    const trimmed = input.message.trim();
    if (!trimmed) {
        throw new Error("Missing message");
    }
    const ctx = await (0, perception_js_1.buildHarveyContext)(input.deps);
    const judgment = (0, judgment_js_1.runJudgment)(ctx, trimmed);
    const history = (0, memory_js_1.getSessionHistory)(sessionId);
    const response = await (0, communication_js_1.runCommunication)({
        ctx,
        judgment,
        operatorMessage: trimmed,
        history,
        sessionId,
    });
    (0, memory_js_1.appendSessionTurn)(sessionId, "user", trimmed);
    (0, memory_js_1.appendSessionTurn)(sessionId, "assistant", response.speech);
    return response;
}
var communication_js_2 = require("./communication.js");
Object.defineProperty(exports, "getHarveyModel", { enumerable: true, get: function () { return communication_js_2.getHarveyModel; } });
