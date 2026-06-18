const axios = require('axios');
const db = require('../config/db');
const logger = require('../config/logger');

const YV_BASE = process.env.YOUVERSION_API_BASE_URL || 'https://api.youversion.com/v1';
const YV_KEY = process.env.YOUVERSION_TOKEN || process.env.YOUVERSION_APP_KEY;
// KJV (id=1) returns 403 unless licensed on YouVersion Platform — BSB (3034) works by default
const DEFAULT_BIBLE_ID = parseInt(process.env.YOUVERSION_DEFAULT_BIBLE_ID || '3034', 10);
const FALLBACK_BIBLE_IDS = (process.env.YOUVERSION_FALLBACK_BIBLE_IDS || '3034,12,206')
  .split(',')
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => Number.isFinite(id) && id > 0);

const BIBLE_NAMES = {
  1: 'KJV',
  8: 'AMPC',
  12: 'ASV',
  59: 'ESV',
  111: 'NIV',
  206: 'WEB',
  3034: 'BSB',
};

const yvClient = axios.create({
  baseURL: YV_BASE.replace(/\/+$/, ''),
  headers: {
    'X-YVP-App-Key': YV_KEY,
    Accept: 'application/json',
  },
  timeout: 12000,
  validateStatus: () => true,
});

const BOOK_ALIASES = {
  genesis: 'GEN', gen: 'GEN',
  exodus: 'EXO', exo: 'EXO',
  leviticus: 'LEV', lev: 'LEV',
  numbers: 'NUM', num: 'NUM',
  deuteronomy: 'DEU', deut: 'DEU',
  joshua: 'JOS', jos: 'JOS',
  judges: 'JDG', jdg: 'JDG',
  ruth: 'RUT', rut: 'RUT',
  samuel: '1SA', psalm: 'PSA', psalms: 'PSA', psa: 'PSA',
  proverbs: 'PRO', prov: 'PRO',
  ecclesiastes: 'ECC', ecc: 'ECC',
  matthew: 'MAT', matt: 'MAT', mat: 'MAT',
  mark: 'MRK', mrk: 'MRK',
  luke: 'LUK', luk: 'LUK',
  john: 'JHN', jhn: 'JHN',
  acts: 'ACT', act: 'ACT',
  romans: 'ROM', rom: 'ROM',
  corinthians: '1CO',
  galatians: 'GAL', gal: 'GAL',
  ephesians: 'EPH', eph: 'EPH',
  philippians: 'PHP', php: 'PHP',
  colossians: 'COL', col: 'COL',
  revelation: 'REV', rev: 'REV',
};

function isInvalidPayload(data) {
  if (!data) return true;
  if (typeof data === 'string') {
    const lower = data.toLowerCase();
    return lower.includes('<!doctype') || lower.includes('<html') || lower.includes('<script');
  }
  return false;
}

function dayOfYear(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function bibleIdsToTry(versionId) {
  const requested = parseInt(versionId, 10);
  const ids = [];
  if (Number.isFinite(requested) && requested > 0) ids.push(requested);
  if (!ids.includes(DEFAULT_BIBLE_ID)) ids.push(DEFAULT_BIBLE_ID);
  for (const id of FALLBACK_BIBLE_IDS) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseReferenceQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;

  if (/^[A-Z0-9]{3}\.\d+(\.\d+)?(-\d+)?$/i.test(raw)) {
    return raw.toUpperCase();
  }

  const match = raw.match(/^(\d?\s*[a-z]+)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/i);
  if (!match) return null;

  const bookKey = match[1].replace(/\s+/g, ' ').trim().toLowerCase();
  const book = BOOK_ALIASES[bookKey] || bookKey.slice(0, 3).toUpperCase();
  const chapter = match[2];
  const verse = match[3];

  if (verse) {
    const end = match[4];
    return end ? `${book}.${chapter}.${verse}-${end}` : `${book}.${chapter}.${verse}`;
  }
  return `${book}.${chapter}`;
}

async function yvFetch(path, { cache = true } = {}) {
  if (!YV_KEY) {
    throw Object.assign(new Error('YouVersion API key not configured'), { status: 503 });
  }

  const cacheKey = `yv:${path}`;

  if (cache) {
    const { rows: cached } = await db.query(
      `SELECT data FROM bible_cache WHERE cache_key = $1 AND expires_at > NOW()`,
      [cacheKey]
    );
    if (cached.length) {
      const data = cached[0].data;
      if (!isInvalidPayload(data)) {
        logger.debug(`Bible cache hit: ${cacheKey}`);
        return data;
      }
      await db.query('DELETE FROM bible_cache WHERE cache_key = $1', [cacheKey]);
      logger.warn('Bible cache entry was invalid HTML, deleted', { cacheKey });
    }
  }

  const resp = await yvClient.get(path);
  const data = resp.data;

  if (resp.status === 403) {
    const err = Object.assign(
      new Error(data?.message || 'YouVersion Bible version not licensed for this app key'),
      { status: 403, yvStatus: 403 }
    );
    throw err;
  }

  if (resp.status >= 400) {
    throw Object.assign(
      new Error(data?.message || `YouVersion API error (${resp.status})`),
      { status: resp.status >= 500 ? 502 : resp.status }
    );
  }

  if (isInvalidPayload(data)) {
    throw Object.assign(new Error('YouVersion API returned invalid response'), { status: 502 });
  }

  if (cache) {
    await db.query(
      `INSERT INTO bible_cache (cache_key, data, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')
       ON CONFLICT (cache_key) DO UPDATE
         SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [cacheKey, JSON.stringify(data)]
    );
  }

  return data;
}

async function resolveBibleId(versionId) {
  const ids = bibleIdsToTry(versionId);
  let lastError = null;

  for (const bibleId of ids) {
    try {
      await yvFetch(`/bibles/${bibleId}`, { cache: true });
      return bibleId;
    } catch (err) {
      lastError = err;
      if (err.status === 403 || err.yvStatus === 403) {
        logger.warn('Bible version access denied, trying fallback', { bibleId });
        continue;
      }
      throw err;
    }
  }

  throw lastError || Object.assign(new Error('No licensed Bible version available'), { status: 403 });
}

function normalizeIndex(raw, bibleId) {
  const books = (raw.books || []).map((book) => ({
    usfm: book.id,
    title: book.title,
    full_title: book.full_title || book.title,
    abbreviation: book.abbreviation || book.title,
    canon: book.canon || 'old_testament',
    chapters: (book.chapters || []).map((chapter) => ({
      number: chapter.id,
      passage_id: chapter.passage_id || `${book.id}.${chapter.id}`,
      title: chapter.title ?? chapter.id,
      verse_count: (chapter.verses || []).length,
    })),
  }));

  return {
    version_id: bibleId,
    version_name: BIBLE_NAMES[bibleId] || `Bible ${bibleId}`,
    text_direction: raw.text_direction || 'ltr',
    books,
  };
}

async function getBibleIndex(versionId) {
  const bibleId = await resolveBibleId(versionId);
  const raw = await yvFetch(`/bibles/${bibleId}/index`, { cache: true });
  return normalizeIndex(raw, bibleId);
}

function parseChapterHtml(html, bookUsfm, chapterNum) {
  if (!html || typeof html !== 'string') return [];

  const verses = [];
  const pattern = /data-usfm="[^"]+\.(\d+)"[^>]*>\s*\1\s*<\/span>([\s\S]*?)(?=data-usfm="[^"]+\.\d+"|<\/p>|$)/gi;
  let match = pattern.exec(html);
  if (match) {
    do {
      const num = parseInt(match[1], 10);
      const text = stripHtml(match[2]);
      if (Number.isFinite(num) && text) {
        verses.push({
          number: num,
          usfm: `${bookUsfm}.${chapterNum}.${num}`,
          text,
        });
      }
      match = pattern.exec(html);
    } while (match);
  }

  if (verses.length) return verses;

  const altPattern = /<span[^>]*class="[^"]*verse[^"]*"[^>]*>(\d+)<\/span>([^<]*)/gi;
  match = altPattern.exec(html);
  if (match) {
    do {
      const num = parseInt(match[1], 10);
      const text = stripHtml(match[2]);
      if (Number.isFinite(num) && text) {
        verses.push({
          number: num,
          usfm: `${bookUsfm}.${chapterNum}.${num}`,
          text,
        });
      }
      match = altPattern.exec(html);
    } while (match);
  }

  return verses;
}

function parseChapterContent(content, passageId, bookUsfm, chapterNum) {
  const text = stripHtml(content);
  if (!text) return [];

  // [1] verse markers (common in YouVersion text output)
  const bracketParts = text.split(/\s*\[(\d+)\]\s*/);
  if (bracketParts.length > 3) {
    const verses = [];
    if (bracketParts[0].trim()) {
      verses.push({
        number: 0,
        usfm: `${bookUsfm}.${chapterNum}.0`,
        text: bracketParts[0].trim(),
      });
    }
    for (let i = 1; i < bracketParts.length; i += 2) {
      const num = parseInt(bracketParts[i], 10);
      const body = (bracketParts[i + 1] || '').trim();
      if (Number.isFinite(num) && body) {
        verses.push({
          number: num,
          usfm: `${bookUsfm}.${chapterNum}.${num}`,
          text: body,
        });
      }
    }
    if (verses.length) return verses;
  }

  // Lines starting with verse number
  const verses = [];
  let current = null;
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d{1,3})\s+(.+)/);
    if (match) {
      if (current) verses.push(current);
      const num = parseInt(match[1], 10);
      current = {
        number: num,
        usfm: `${bookUsfm}.${chapterNum}.${num}`,
        text: match[2].trim(),
      };
    } else if (current) {
      current.text = `${current.text} ${trimmed}`.trim();
    }
  }
  if (current) verses.push(current);
  if (verses.length) return verses;

  return [{
    number: 1,
    usfm: passageId,
    text,
  }];
}

async function getChapterWithVerses(versionId, bookUsfm, chapterNum) {
  const bibleId = await resolveBibleId(versionId);
  const book = String(bookUsfm || '').trim().toUpperCase();
  const chapter = parseInt(chapterNum, 10);
  if (!book || book.length !== 3 || !Number.isFinite(chapter) || chapter < 1) {
    throw Object.assign(new Error('Invalid book or chapter'), { status: 400 });
  }

  const passageId = `${book}.${chapter}`;
  const data = await fetchPassageRaw(bibleId, passageId);
  let verses = parseChapterContent(data.content, passageId, book, chapter);

  if (verses.length <= 1) {
    try {
      const htmlData = await yvFetch(
        `/bibles/${bibleId}/passages/${encodeURIComponent(passageId)}?format=html`,
        { cache: true }
      );
      const fromHtml = parseChapterHtml(htmlData.content, book, chapter);
      if (fromHtml.length > verses.length) {
        verses = fromHtml;
      }
    } catch (err) {
      logger.debug('Chapter HTML parse skipped', { passageId, error: err.message });
    }
  }

  return {
    book_usfm: book,
    chapter,
    passage_id: passageId,
    reference: data.reference || passageId,
    verses,
    version_id: bibleId,
    version_name: BIBLE_NAMES[bibleId] || `Bible ${bibleId}`,
  };
}

async function fetchPassageRaw(bibleId, passageId) {
  return yvFetch(
    `/bibles/${bibleId}/passages/${encodeURIComponent(passageId)}?format=text`,
    { cache: true }
  );
}

async function getPassage(versionId, passageId) {
  const ids = bibleIdsToTry(versionId);
  let lastError = null;

  for (const bibleId of ids) {
    try {
      const data = await fetchPassageRaw(bibleId, passageId);
      return {
        usfm: data.id || passageId,
        reference: data.reference || passageId,
        text: stripHtml(data.content),
        version_id: bibleId,
        version_name: BIBLE_NAMES[bibleId] || `Bible ${bibleId}`,
      };
    } catch (err) {
      lastError = err;
      if (err.status === 403 || err.yvStatus === 403) {
        logger.warn('Bible version access denied, trying fallback', { bibleId, passageId });
        continue;
      }
      throw err;
    }
  }

  throw lastError || Object.assign(new Error('No licensed Bible version available'), { status: 403 });
}

async function getVerseOfTheDay(versionId) {
  const day = dayOfYear();
  const votd = await yvFetch(`/verse_of_the_days/${day}`);
  const passage = await getPassage(versionId, votd.passage_id);
  return {
    day: votd.day,
    passage_id: votd.passage_id,
    data: passage,
  };
}

async function searchPassages(query, versionId) {
  const passageId = parseReferenceQuery(query);
  if (!passageId) {
    return {
      hint: 'Try a reference like John 3:16 or JHN.3.16',
      data: [],
    };
  }

  const passage = await getPassage(versionId, passageId);
  return { data: [passage] };
}

async function purgeInvalidCache() {
  const { rowCount } = await db.query(
    `DELETE FROM bible_cache
     WHERE data::text ILIKE '%<!doctype%'
        OR data::text ILIKE '%<html%'
        OR data::text ILIKE '%<script%'
        OR data::text ILIKE '%Access denied%'`
  );
  if (rowCount > 0) {
    logger.info('Purged invalid Bible cache entries', { count: rowCount });
  }
}

module.exports = {
  yvFetch,
  getPassage,
  getVerseOfTheDay,
  searchPassages,
  getBibleIndex,
  getChapterWithVerses,
  parseReferenceQuery,
  purgeInvalidCache,
  stripHtml,
};
