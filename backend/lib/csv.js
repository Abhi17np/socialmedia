/**
 * Minimal RFC 4180 CSV read/write — no dependency pulled in just for
 * CSV import/export. Handles quoted fields, embedded commas/newlines,
 * and "" as an escaped quote; nothing fancier (no alternate delimiters,
 * no BOM handling) since every caller here both produces and consumes
 * its own files.
 */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// First row is the header; each subsequent row becomes {header: value}.
// Blank trailing lines (a file ending in a newline parses to one empty
// row) are dropped.
function parseCsvToObjects(text) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
}

function toCsvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map(toCsvField).join(',');
  const lines = rows.map((row) => columns.map((col) => toCsvField(row[col])).join(','));
  return [header, ...lines].join('\r\n');
}

module.exports = { parseCsv, parseCsvToObjects, toCsv, toCsvField };
