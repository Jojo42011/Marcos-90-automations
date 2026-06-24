/**
 * Seed local voice-clone reference clip for dev testing.
 * Run: npx ts-node scripts/seed-voice-clone-local.ts
 */
import fs from "fs";
import path from "path";
import {
  createReferenceClip,
  getPrimaryReferenceClip,
  setPrimaryReferenceClip,
  getVoiceCloneDb,
} from "../src/core/voiceCloneStore";

const root = path.join(process.cwd(), "data", "voice-clone");
const refDir = path.join(root, "reference");
fs.mkdirSync(refDir, { recursive: true });
fs.mkdirSync(path.join(root, "generated"), { recursive: true });
fs.mkdirSync(path.join(root, "exports"), { recursive: true });

const refWav = path.join(refDir, "marco-dev-reference.wav");

if (!fs.existsSync(refWav)) {
  console.log("Create reference WAV first: run scripts/run-voxcpm-local.ps1 or add a .wav manually");
}

getVoiceCloneDb();

const existing = getPrimaryReferenceClip();
if (existing?.localAudioPath && fs.existsSync(existing.localAudioPath)) {
  console.log("Primary reference clip already set:", existing.localAudioPath);
  process.exit(0);
}

const clip = createReferenceClip({
  sourceUrl: "https://www.tiktok.com/@puga.realtor (local dev)",
  localAudioPath: refWav,
  qualityRating: 4,
  transcript: "Hey everyone, Marco here with a quick update on the San Antonio market.",
  isPrimary: false,
});

if (clip.id) {
  setPrimaryReferenceClip(clip.id);
  console.log("Seeded primary reference clip:", refWav);
}
