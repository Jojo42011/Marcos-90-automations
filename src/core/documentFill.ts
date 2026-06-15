import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";

import {
  resolveFieldValues,
  resolveGeneratedDocsDir,
  type DocumentTemplate,
  type Transaction,
} from "./transactionsStore.js";

export interface FillResult {
  success: boolean;
  outputPath?: string;
  filledFields: string[];
  missingFields: string[];
  error?: string;
}

export async function inspectTemplatePdfFields(filePath: string): Promise<Array<{ name: string; type: string }>> {
  const bytes = readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();
  return form.getFields().map((f) => ({ name: f.getName(), type: f.constructor.name }));
}

export async function fillDocumentTemplate(template: DocumentTemplate, tx: Transaction): Promise<FillResult> {
  try {
    const bytes = readFileSync(template.filePath);
    const pdfDoc = await PDFDocument.load(bytes);
    const form = pdfDoc.getForm();

    const values = resolveFieldValues(tx, template.fieldMapping || {});
    const filledFields: string[] = [];
    const missingFields: string[] = [];

    for (const [fieldName, value] of Object.entries(values)) {
      try {
        const field = form.getTextField(fieldName);
        if (value) {
          field.setText(value);
          filledFields.push(fieldName);
        } else {
          missingFields.push(fieldName);
        }
      } catch {
        missingFields.push(fieldName);
      }
    }

    const outputDir = resolveGeneratedDocsDir();
    const outputFileName = `${tx.id}-${template.templateType}-${Date.now()}.pdf`;
    const outputPath = path.join(outputDir, outputFileName);

    const filledBytes = await pdfDoc.save();
    writeFileSync(outputPath, filledBytes);

    console.log(
      "[DocAutoFill] Filled",
      template.name,
      "-",
      filledFields.length,
      "fields,",
      missingFields.length,
      "missing",
    );

    return { success: true, outputPath, filledFields, missingFields };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[DocAutoFill] Error filling", template.name, ":", err);
    return { success: false, filledFields: [], missingFields: [], error: msg };
  }
}
