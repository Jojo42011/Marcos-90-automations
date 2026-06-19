"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingDimensions = embeddingDimensions;
exports.cosineSimilarity = cosineSimilarity;
exports.blobToFloat32 = blobToFloat32;
exports.float32ToBlob = float32ToBlob;
exports.embedText = embedText;
exports.backfillEmbeddings = backfillEmbeddings;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;
function embeddingDimensions() {
    return EMBEDDING_DIM;
}
function cosineSimilarity(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function blobToFloat32(blob) {
    if (!blob || blob.length === 0)
        return null;
    const arr = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return arr;
}
function float32ToBlob(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
async function embedText(text) {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key || !text.trim())
        return null;
    try {
        const res = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
        });
        if (!res.ok) {
            console.warn("[hull/embeddings] OpenAI error:", res.status);
            return null;
        }
        const data = (await res.json());
        const emb = data.data?.[0]?.embedding;
        if (!emb?.length)
            return null;
        return new Float32Array(emb);
    }
    catch (err) {
        console.warn("[hull/embeddings] fetch failed:", err instanceof Error ? err.message : err);
        return null;
    }
}
async function backfillEmbeddings(limit = 100) {
    const { getHullDb } = await Promise.resolve().then(() => __importStar(require("./store.js")));
    const db = getHullDb();
    const rows = db
        .prepare("SELECT id, content FROM facts WHERE superseded_by IS NULL AND embedding IS NULL LIMIT ?")
        .all(limit);
    let count = 0;
    for (const row of rows) {
        const vec = await embedText(row.content);
        if (!vec)
            break;
        db.prepare("UPDATE facts SET embedding = ? WHERE id = ?").run(float32ToBlob(vec), row.id);
        count++;
    }
    if (count > 0)
        console.log(`[hull/embeddings] backfilled ${count} facts`);
    return count;
}
