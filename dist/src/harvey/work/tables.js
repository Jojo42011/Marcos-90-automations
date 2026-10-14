"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTableInPage = readTableInPage;
exports.tableCode = tableCode;
/** Fixed DOM-only table reader: no hidden application state or model-authored code. */
function readTableInPage(input) {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    const roots = Array.from(document.querySelectorAll(input.target || 'table,[role="grid"],[role="table"]')).filter(visible);
    if (roots.length !== 1)
        return { error: roots.length ? "More than one table; use a unique observed selector" : "No rendered table at this target; inspect a semantic snapshot or the relevant tab", tableCount: roots.length };
    const root = roots[0];
    if (!root.matches('table,[role="grid"],[role="table"]'))
        return { error: "Target must be an observed table or grid" };
    const headers = Array.from(root.querySelectorAll('th,[role="columnheader"]')).map(e => (e.textContent || '').trim().slice(0, 200));
    const all = Array.from(root.querySelectorAll('tr,[role="row"]')).filter(visible).filter(r => r.querySelector('td,[role="cell"],[role="gridcell"]'));
    const offset = input.offset || 0, rows = [];
    let size = 0, truncated = false;
    for (const row of all.slice(offset, offset + 24)) {
        const raw = Array.from(row.querySelectorAll('td,[role="cell"],[role="gridcell"]')).map(e => e.innerText?.trim() || e.textContent?.trim() || '');
        const links = Array.from(row.querySelectorAll('a[href]')).slice(0, 8).map(e => ({ text: (e.textContent || '').trim().slice(0, 100), href: e.href }));
        const clipped = raw.length > 30 || raw.some(v => v.length > 600);
        const item = { id: row.getAttribute('data-id') || row.getAttribute('data-row-key') || links[0]?.href || null, cells: raw.slice(0, 30).map(v => v.slice(0, 600)), links, truncated: clipped };
        const n = JSON.stringify(item).length;
        if (size + n > 9000) {
            if (!rows.length)
                return { error: "This rendered row exceeds the read limit. Inspect a smaller region or open its profile; retrying the same offset cannot advance.", offset, renderedRowCount: all.length };
            truncated = true;
            break;
        }
        rows.push(item);
        size += n;
        truncated ||= clipped;
    }
    let scroll = root;
    while (scroll && !(scroll.scrollHeight > scroll.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(scroll).overflowY)))
        scroll = scroll.parentElement;
    return { url: location.origin + location.pathname, headers, rows, offset, nextOffset: offset + rows.length < all.length ? offset + rows.length : null, renderedRowCount: all.length, totalFromAria: root.getAttribute('aria-rowcount'), truncated,
        scroll: scroll ? { top: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight } : null,
        coverage: "Only currently rendered DOM rows. A null nextOffset is NOT proof the dataset is complete. Read the status filter and total, navigate actual pagination or scroll the table, then inspect fresh rows. Null IDs need a stable profile identifier before saving." };
}
function tableCode(input) { return `() => (${readTableInPage.toString()})(${JSON.stringify(input)})`; }
