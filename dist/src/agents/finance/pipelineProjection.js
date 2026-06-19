"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPipelineProjection = getPipelineProjection;
const financeStore_js_1 = require("../../core/financeStore.js");
function getPipelineProjection() {
    return (0, financeStore_js_1.generatePipelineProjection)();
}
