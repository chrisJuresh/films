import { json, error } from '@sveltejs/kit';
import zlib from 'node:zlib';
import { importLetterboxd, dismissUnmatched, clearUnmatched } from '$lib/server/db.js';

// Extract a single entry (by basename) from a zip buffer using its central
// directory. Zero-dependency: only node:zlib (inflateRaw) is needed for the
// standard 'deflate' method letterboxd uses. Keeps the app's no-runtime-deps
// design intact (a host `unzip` wouldn't exist inside the alpine container).
function extractFromZip(buf, wantName) {
  const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const base = name.split('/').pop().toLowerCase();
    if (base === wantName.toLowerCase()) {
      if (buf.readUInt32LE(localOff) !== LOC) return null;
      const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// RFC-4180-ish CSV parse (handles quoted fields with commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// letterboxd watched.csv columns: Date, Name, Year, Letterboxd URI.
function parseWatched(csv) {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const iName = head.indexOf('name'), iYear = head.indexOf('year'), iDate = head.indexOf('date');
  if (iName < 0) return [];
  return rows.slice(1)
    .filter((r) => r[iName])
    .map((r) => ({ name: r[iName], year: iYear >= 0 ? r[iYear] : '', date: iDate >= 0 ? r[iDate] : '' }));
}

export async function POST({ request, locals }) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw error(400, 'No file uploaded.');
  const buf = Buffer.from(await file.arrayBuffer());

  let csv;
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {   // 'PK' magic -> zip
    csv = extractFromZip(buf, 'watched.csv');
    if (csv == null) throw error(400, 'That .zip does not contain a watched.csv.');
  } else {
    csv = buf.toString('utf8');
  }

  const rows = parseWatched(csv);
  if (!rows.length) throw error(400, 'No rows found. Expected a letterboxd watched.csv (Date, Name, Year, Letterboxd URI).');
  return json(importLetterboxd(locals.user, rows));
}

// Prune the persistent "not found in the catalogue" list: one entry, or all.
export async function DELETE({ request, locals }) {
  const body = await request.json().catch(() => ({}));
  if (body?.all) clearUnmatched(locals.user);
  else if (body?.name != null) dismissUnmatched(locals.user, body.name, body.year);
  else throw error(400, 'Nothing to remove.');
  return json({ ok: true });
}
