"use strict";
/**
 * Branded client property PDF — "the homes we picked for you", ready to send.
 *
 * Built with pdf-lib, which this app already ships for transaction documents
 * (the overlay deploy path cannot npm install, so no new dependency was an
 * actual constraint, not a preference).
 *
 * Layout: US Letter, a branded header, then one card per property — photo,
 * price, address, specs, a remarks excerpt, and a clickable link to the
 * listing page. Photos are fetched server-side from the MLS CDN at generate
 * time; a photo that fails to fetch degrades to a text-only card rather than
 * failing the document — a missing image must not cost the client the other
 * six homes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPropertyPdf = buildPropertyPdf;
const pdf_lib_1 = require("pdf-lib");
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 46;
const CARD_H = 168;
const PHOTO_W = 200;
const PHOTO_H = 134;
const BRAND = (0, pdf_lib_1.rgb)(0.055, 0.36, 0.30); // deep teal — matches the app's accent
const INK = (0, pdf_lib_1.rgb)(0.09, 0.12, 0.11);
const MUTED = (0, pdf_lib_1.rgb)(0.38, 0.43, 0.41);
const RULE = (0, pdf_lib_1.rgb)(0.82, 0.85, 0.84);
function money(n) {
    return n == null ? "-" : "$" + Math.round(n).toLocaleString();
}
/**
 * The standard fonts encode WinAnsi only, and MLS remarks carry whatever an
 * agent's word processor produced — one un-encodable glyph fails the whole
 * document (found live: "→"). Everything drawn passes through here.
 */
function winAnsiSafe(s) {
    return s
        .replace(/[‘’‚]/g, "'")
        .replace(/[“”„]/g, '"')
        .replace(/[–—―]/g, "-")
        .replace(/…/g, "...")
        .replace(/[→➔➜]/g, ">")
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ")
        .replace(/[ \t]{2,}/g, " ");
}
/** pdf-lib has no text wrapping; measure and break on spaces ourselves. */
function wrapText(text, font, size, maxWidth, maxLines) {
    const words = winAnsiSafe(text).replace(/\s+/g, " ").trim().split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
        const probe = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
            line = probe;
            continue;
        }
        lines.push(line);
        line = w;
        if (lines.length === maxLines - 1)
            break;
    }
    if (line && lines.length < maxLines)
        lines.push(line);
    if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
        lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, " …");
    }
    return lines;
}
async function fetchPhoto(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok)
            return null;
        const type = res.headers.get("content-type") || "";
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length)
            return null;
        if (/png/i.test(type) || (bytes[0] === 0x89 && bytes[1] === 0x50))
            return { bytes, kind: "png" };
        return { bytes, kind: "jpg" };
    }
    catch {
        return null;
    }
}
async function buildPropertyPdf(input) {
    const doc = await pdf_lib_1.PDFDocument.create();
    const helv = await doc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const bold = await doc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    const live = input.entries.filter((e) => e.listing);
    doc.setTitle(`Properties for ${input.clientName}`);
    doc.setAuthor("Marco Puga Real Estate");
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    /* Header — brand block, once. */
    page.drawText("MARCO PUGA", { x: MARGIN, y: y - 18, size: 20, font: bold, color: BRAND });
    page.drawText("REAL ESTATE", { x: MARGIN + 152, y: y - 18, size: 20, font: helv, color: INK });
    y -= 40;
    page.drawText(winAnsiSafe(`Homes picked for ${input.clientName}`), { x: MARGIN, y, size: 13, font: helv, color: INK });
    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const dateW = helv.widthOfTextAtSize(dateStr, 10);
    page.drawText(dateStr, { x: PAGE_W - MARGIN - dateW, y: y + 1, size: 10, font: helv, color: MUTED });
    y -= 14;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.5, color: BRAND });
    y -= 22;
    const footer = (p) => {
        p.drawText("Marco Puga · marcopuga.com · @puga.realtor", {
            x: MARGIN, y: 26, size: 8.5, font: helv, color: MUTED,
        });
    };
    for (const entry of live) {
        const l = entry.listing;
        if (y - CARD_H < 48) {
            footer(page);
            page = doc.addPage([PAGE_W, PAGE_H]);
            y = PAGE_H - MARGIN;
        }
        const top = y;
        /* Photo (left) — degrade to a flat panel when the CDN fetch fails. */
        let drewPhoto = false;
        if (l.photoUrl) {
            const photo = await fetchPhoto(l.photoUrl);
            if (photo) {
                try {
                    const img = photo.kind === "png" ? await doc.embedPng(photo.bytes) : await doc.embedJpg(photo.bytes);
                    page.drawImage(img, { x: MARGIN, y: top - PHOTO_H, width: PHOTO_W, height: PHOTO_H });
                    drewPhoto = true;
                }
                catch { /* corrupt image — fall through to the panel */ }
            }
        }
        if (!drewPhoto) {
            page.drawRectangle({ x: MARGIN, y: top - PHOTO_H, width: PHOTO_W, height: PHOTO_H, color: (0, pdf_lib_1.rgb)(0.92, 0.94, 0.93) });
            page.drawText("photo unavailable", { x: MARGIN + 54, y: top - PHOTO_H / 2 - 4, size: 9, font: helv, color: MUTED });
        }
        /* Facts (right). */
        const tx = MARGIN + PHOTO_W + 18;
        const textW = PAGE_W - MARGIN - tx;
        let ty = top - 14;
        page.drawText(money(l.listPrice), { x: tx, y: ty, size: 17, font: bold, color: BRAND });
        ty -= 17;
        for (const line of wrapText(l.street || "(no address)", bold, 11.5, textW, 2)) {
            page.drawText(line, { x: tx, y: ty, size: 11.5, font: bold, color: INK });
            ty -= 14;
        }
        const cityLine = [l.city, l.state, l.postalCode].filter(Boolean).join(", ");
        if (cityLine) {
            page.drawText(winAnsiSafe(cityLine), { x: tx, y: ty, size: 10, font: helv, color: MUTED });
            ty -= 15;
        }
        const specs = [
            l.beds != null ? `${l.beds} bed` : null,
            l.baths != null ? `${l.baths} bath` : null,
            l.livingArea ? `${Math.round(l.livingArea).toLocaleString()} sqft` : null,
            l.yearBuilt ? `built ${l.yearBuilt}` : null,
        ].filter(Boolean).join("  ·  ");
        if (specs) {
            page.drawText(specs, { x: tx, y: ty, size: 10, font: helv, color: INK });
            ty -= 15;
        }
        if (l.subdivision) {
            page.drawText(winAnsiSafe(l.subdivision), { x: tx, y: ty, size: 9.5, font: helv, color: MUTED });
            ty -= 14;
        }
        if (l.publicRemarks) {
            for (const line of wrapText(l.publicRemarks, helv, 8.8, textW, 3)) {
                page.drawText(line, { x: tx, y: ty, size: 8.8, font: helv, color: MUTED });
                ty -= 11;
            }
        }
        /* Clickable link, drawn as text with a link annotation over it. */
        const linkUrl = `${input.linkOrigin.replace(/\/+$/, "")}/listing?key=${encodeURIComponent(l.listingKey)}`;
        /* ASCII only: the standard Helvetica encoding (WinAnsi) cannot encode
           an arrow glyph, and one → in a label 500 lines from here failed the
           whole document. */
        const linkLabel = "View full listing >>";
        const linkY = top - CARD_H + 22;
        page.drawText(linkLabel, { x: tx, y: linkY, size: 9.5, font: bold, color: BRAND });
        const linkW = bold.widthOfTextAtSize(linkLabel, 9.5);
        const linkAnnot = doc.context.register(doc.context.obj({
            Type: "Annot", Subtype: "Link",
            Rect: [tx, linkY - 3, tx + linkW, linkY + 10],
            Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: linkUrl },
        }));
        const annots = page.node.Annots();
        if (annots)
            annots.push(linkAnnot);
        else
            page.node.set(doc.context.obj("Annots"), doc.context.obj([linkAnnot]));
        if (l.mlsNumber) {
            const mlsText = `MLS ${l.mlsNumber}`;
            const w = helv.widthOfTextAtSize(mlsText, 8.5);
            page.drawText(mlsText, { x: PAGE_W - MARGIN - w, y: linkY, size: 8.5, font: helv, color: MUTED });
        }
        y = top - CARD_H;
        page.drawLine({ start: { x: MARGIN, y: y + 8 }, end: { x: PAGE_W - MARGIN, y: y + 8 }, thickness: 0.6, color: RULE });
        y -= 8;
    }
    /* Homes that left the market since they were shortlisted: named, not hidden. */
    const gone = input.entries.filter((e) => e.gone);
    if (gone.length) {
        if (y < 90) {
            footer(page);
            page = doc.addPage([PAGE_W, PAGE_H]);
            y = PAGE_H - MARGIN;
        }
        page.drawText(`${gone.length} previously shortlisted home${gone.length === 1 ? " is" : "s are"} no longer on the market and ${gone.length === 1 ? "was" : "were"} left out.`, { x: MARGIN, y, size: 9, font: helv, color: MUTED });
    }
    footer(page);
    return doc.save();
}
