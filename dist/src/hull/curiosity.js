"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeAppendCuriosityQuestion = maybeAppendCuriosityQuestion;
exports.storeIdentityAnswer = storeIdentityAnswer;
const crypto_1 = require("crypto");
const store_js_1 = require("./memory/store.js");
const embeddings_js_1 = require("./memory/embeddings.js");
const DIMENSION_QUESTIONS = {
    DECISIONS: [
        "When you face a big decision, do you move fast or wait for more data?",
        "What makes a decision feel right to you — gut or numbers?",
        "What's a decision you reversed recently and why?",
        "How do you decide when speed beats perfection?",
        "What decision pattern do you repeat most in your business?",
    ],
    VALUES: [
        "What would you never compromise on in a deal?",
        "Where do you draw the line with clients who push boundaries?",
        "What value guides you when two good options conflict?",
        "What would make you walk away from money?",
        "What do you want every client to feel after working with you?",
    ],
    FEARS: [
        "What does failure look like for you personally?",
        "What keeps you up at night about the business?",
        "What risk do you avoid thinking about?",
        "What would a bad month feel like beyond the numbers?",
        "What failure pattern do you watch for in yourself?",
    ],
    MOTIVATION: [
        "Why are you building toward $20M — what does it unlock?",
        "Who are you building this for beyond yourself?",
        "What would make this year feel worth it?",
        "What milestone would change how you operate?",
        "What fuels you on the days volume is grinding?",
    ],
    EMOTIONS: [
        "How do you act under pressure when deals stack up?",
        "What does stress look like for you — visible or hidden?",
        "What genuinely makes you angry in business?",
        "How do you reset after a tough client conversation?",
        "What emotion do you trust as a signal?",
    ],
    RELATIONSHIPS: [
        "How do you decide who to trust in business?",
        "What breaks trust for you instantly?",
        "How does friendship change how you handle business friction?",
        "Who do you go to for hard decisions?",
        "How do you maintain boundaries with clients?",
    ],
    MONEY: [
        "Beyond what it buys — what's your relationship with money?",
        "How do you decide when to hold price vs flex?",
        "What changes for you at 10x revenue?",
        "What spending feels irresponsible vs strategic?",
        "How do you price your time?",
    ],
    IDENTITY: [
        "How do you see yourself when you're not in the room?",
        "What are you still figuring out about your role?",
        "What title or label fits you least?",
        "What do you want your team to say about how you lead?",
        "What part of your identity is most tied to production numbers?",
    ],
    VISION: [
        "What does success look like in 3 years specifically?",
        "What would you keep even at 10x scale?",
        "What would make you walk away from this business?",
        "What does the ideal week look like at goal?",
        "What legacy are you building in San Antonio real estate?",
    ],
    CONFLICT: [
        "Do you address friction early or let it resolve?",
        "What's the hardest conversation you've had recently?",
        "How do you handle a team member missing standards?",
        "When do you push back vs accommodate?",
        "What conflict pattern do you want to break?",
    ],
    LEARNING: [
        "How do you grow — books, people, or trial and error?",
        "What changed your mind in the last year?",
        "What do you know you need to learn but avoid?",
        "Who taught you something that changed how you sell?",
        "What skill gap costs you the most right now?",
    ],
    ENERGY: [
        "What are your peak hours for high-value work?",
        "What drains you fastest in a week?",
        "How do you recover after a heavy call block?",
        "What does a genuinely good day feel like?",
        "What activity gives you energy back mid-day?",
    ],
};
let lastCuriosityAt = 0;
function maybeAppendCuriosityQuestion(speech, hadToolOnly) {
    if (hadToolOnly)
        return speech;
    if (!speech.trim())
        return speech;
    const hourMs = 60 * 60 * 1000;
    if (Date.now() - lastCuriosityAt < hourMs)
        return speech;
    if (Math.random() > 0.3)
        return speech;
    const db = (0, store_js_1.getHullDb)();
    const dims = db
        .prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY confidence ASC")
        .all();
    if (!dims.length)
        return speech;
    const dim = dims[0].dimension;
    const pool = DIMENSION_QUESTIONS[dim] || [];
    const asked = db
        .prepare("SELECT question FROM identity_questions WHERE dimension = ?")
        .all(dim);
    const askedSet = new Set(asked.map((a) => a.question));
    const available = pool.filter((q) => !askedSet.has(q));
    if (!available.length)
        return speech;
    const question = available[Math.floor(Math.random() * available.length)];
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO identity_questions (id, dimension, question, asked_at, answered) VALUES (?, ?, ?, ?, 0)").run(id, dim, question, now);
    lastCuriosityAt = Date.now();
    return `${speech}\n\n${question}`;
}
async function storeIdentityAnswer(dimension, answer) {
    const db = (0, store_js_1.getHullDb)();
    const now = new Date().toISOString();
    const id = (0, crypto_1.randomUUID)();
    const vec = await (0, embeddings_js_1.embedText)(answer);
    db.prepare(`INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at, embedding)
     VALUES (?, ?, 'identity', ?, 1.5, 0, ?, ?, ?)`).run(id, answer.trim(), dimension.toLowerCase(), now, now, vec ? (0, embeddings_js_1.float32ToBlob)(vec) : null);
    const row = db
        .prepare("SELECT confidence FROM identity_dimensions WHERE dimension = ?")
        .get(dimension);
    const conf = Math.min(1, (row?.confidence ?? 0) + 0.2);
    db.prepare("UPDATE identity_dimensions SET confidence = ?, updated_at = ? WHERE dimension = ?").run(conf, now, dimension);
    db.prepare("UPDATE identity_questions SET answered = 1, answer_fact_id = ? WHERE dimension = ? AND answered = 0 ORDER BY asked_at DESC LIMIT 1").run(id, dimension);
}
