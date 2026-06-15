"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectTemplatePdfFields = inspectTemplatePdfFields;
exports.fillDocumentTemplate = fillDocumentTemplate;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const pdf_lib_1 = require("pdf-lib");
const transactionsStore_js_1 = require("./transactionsStore.js");
async function inspectTemplatePdfFields(filePath) {
    const bytes = (0, fs_1.readFileSync)(filePath);
    const pdfDoc = await pdf_lib_1.PDFDocument.load(bytes);
    const form = pdfDoc.getForm();
    return form.getFields().map((f) => ({ name: f.getName(), type: f.constructor.name }));
}
async function fillDocumentTemplate(template, tx) {
    try {
        const bytes = (0, fs_1.readFileSync)(template.filePath);
        const pdfDoc = await pdf_lib_1.PDFDocument.load(bytes);
        const form = pdfDoc.getForm();
        const values = (0, transactionsStore_js_1.resolveFieldValues)(tx, template.fieldMapping || {});
        const filledFields = [];
        const missingFields = [];
        for (const [fieldName, value] of Object.entries(values)) {
            try {
                const field = form.getTextField(fieldName);
                if (value) {
                    field.setText(value);
                    filledFields.push(fieldName);
                }
                else {
                    missingFields.push(fieldName);
                }
            }
            catch {
                missingFields.push(fieldName);
            }
        }
        const outputDir = (0, transactionsStore_js_1.resolveGeneratedDocsDir)();
        const outputFileName = `${tx.id}-${template.templateType}-${Date.now()}.pdf`;
        const outputPath = path_1.default.join(outputDir, outputFileName);
        const filledBytes = await pdfDoc.save();
        (0, fs_1.writeFileSync)(outputPath, filledBytes);
        console.log("[DocAutoFill] Filled", template.name, "-", filledFields.length, "fields,", missingFields.length, "missing");
        return { success: true, outputPath, filledFields, missingFields };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[DocAutoFill] Error filling", template.name, ":", err);
        return { success: false, filledFields: [], missingFields: [], error: msg };
    }
}
