// Shared sheet-fetching and CSV-parsing utilities.
// generate.js is left untouched; this module is imported by pulse.js.

// --- CSV parsing (RFC 4180-compliant, handles embedded newlines in quoted fields) ---
//
// Windsor exports review_comment and other CRM columns that contain multi-line text.
// Splitting by \n first (as generate.js does) breaks those rows. This parser reads
// the raw text character-by-character so quoted newlines are correctly absorbed
// into the field rather than treated as row boundaries.

export function parseCSV(text) {
  const rows = [];
  let pos = 0;
  const len = text.length;

  function parseField() {
    if (pos >= len) return '';
    if (text[pos] === '"') {
      pos++; // skip opening quote
      let val = '';
      while (pos < len) {
        if (text[pos] === '"') {
          if (pos + 1 < len && text[pos + 1] === '"') { val += '"'; pos += 2; }
          else { pos++; break; } // closing quote
        } else {
          val += text[pos++];
        }
      }
      return val;
    }
    let val = '';
    while (pos < len && text[pos] !== ',' && text[pos] !== '\n' && text[pos] !== '\r') {
      val += text[pos++];
    }
    return val;
  }

  function parseRow() {
    const row = [];
    while (pos < len) {
      row.push(parseField());
      if (pos < len && text[pos] === ',') { pos++; }
      else break;
    }
    if (pos < len && text[pos] === '\r') pos++;
    if (pos < len && text[pos] === '\n') pos++;
    return row;
  }

  if (pos >= len) return [];
  const headers = parseRow().map(h => h.trim());

  while (pos < len) {
    const raw = parseRow();
    if (!raw.length || (raw.length === 1 && raw[0] === '')) continue;
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (raw[i] ?? '').trim(); });
    rows.push(obj);
  }

  return rows;
}

// --- Sheet fetching ---

export async function fetchSheet(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Sheet1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching sheet ${sheetId}`);
  return parseCSV(await res.text());
}

// --- Number parsing ---

// Returns 0 (not null) for missing/unparseable values so callers can safely add.
export function toNum(val) {
  const n = parseFloat(String(val ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
