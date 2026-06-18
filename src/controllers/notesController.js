const db     = require('../config/db');
const PDFDoc = require('pdfkit');
const { resolveStreamId } = require('../services/laravelSync');

async function resolveOptionalStreamId(raw, title) {
  if (!raw) return null;
  return resolveStreamId(raw, title);
}

function dbUserId(req) {
  return req.user.dbId;
}

// ── CREATE note ───────────────────────────────────────────────────────────────
async function createNote(req, res, next) {
  try {
    const { content, streamId, streamTimestamp } = req.body;
    if (!content?.trim()) {
      return res.status(400).json({ error: 'Note content is required' });
    }

    const resolvedStreamId = await resolveOptionalStreamId(
      streamId,
      req.body.streamTitle
    );

    const { rows } = await db.query(
      `INSERT INTO notes (user_id, stream_id, content, stream_timestamp)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [dbUserId(req), resolvedStreamId, content.trim(), streamTimestamp || null]
    );
    res.status(201).json({ note: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── GET all notes for current user (optionally filtered by stream) ─────────────
async function getNotes(req, res, next) {
  try {
    const resolvedStreamId = await resolveOptionalStreamId(
      req.query.streamId,
      req.query.title
    );
    const limit  = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = parseInt(req.query.offset || '0');

    let query = `
      SELECT n.*, s.title AS stream_title
      FROM notes n
      LEFT JOIN streams s ON s.id = n.stream_id
      WHERE n.user_id = $1
      ${resolvedStreamId ? 'AND n.stream_id = $4' : ''}
      ORDER BY n.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const params = resolvedStreamId
      ? [dbUserId(req), limit, offset, resolvedStreamId]
      : [dbUserId(req), limit, offset];

    const { rows } = await db.query(query, params);

    // Total count for pagination
    const countRes = await db.query(
      `SELECT COUNT(*) FROM notes WHERE user_id = $1 ${resolvedStreamId ? 'AND stream_id = $2' : ''}`,
      resolvedStreamId ? [dbUserId(req), resolvedStreamId] : [dbUserId(req)]
    );

    res.json({
      notes: rows,
      total: parseInt(countRes.rows[0].count),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
}

// ── GET single note ────────────────────────────────────────────────────────────
async function getNote(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT n.*, s.title AS stream_title
       FROM notes n
       LEFT JOIN streams s ON s.id = n.stream_id
       WHERE n.id = $1 AND n.user_id = $2`,
      [id, dbUserId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json({ note: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── UPDATE note ────────────────────────────────────────────────────────────────
async function updateNote(req, res, next) {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });

    const { rows } = await db.query(
      `UPDATE notes SET content = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [content.trim(), id, dbUserId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json({ note: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── DELETE note ────────────────────────────────────────────────────────────────
async function deleteNote(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, dbUserId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── EXPORT notes as plain text ─────────────────────────────────────────────────
async function exportText(req, res, next) {
  try {
    const resolvedStreamId = await resolveOptionalStreamId(
      req.query.streamId,
      req.query.title
    );
    const { rows } = await db.query(
      `SELECT n.content, n.stream_timestamp, n.created_at, s.title AS stream_title
       FROM notes n
       LEFT JOIN streams s ON s.id = n.stream_id
       WHERE n.user_id = $1 ${resolvedStreamId ? 'AND n.stream_id = $2' : ''}
       ORDER BY n.created_at ASC`,
      resolvedStreamId ? [dbUserId(req), resolvedStreamId] : [dbUserId(req)]
    );

    const lines = rows.map((n) => {
      const ts  = n.stream_timestamp != null ? ` [${formatTimestamp(n.stream_timestamp)}]` : '';
      const date = new Date(n.created_at).toLocaleString();
      return `[${date}]${ts}\n${n.content}\n`;
    });

    const text = `MY NOTES${resolvedStreamId ? ` — ${rows[0]?.stream_title || ''}` : ''}\n\n` + lines.join('\n---\n\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="notes.txt"`);
    res.send(text);
  } catch (err) {
    next(err);
  }
}

// ── EXPORT notes as PDF ────────────────────────────────────────────────────────
async function exportPDF(req, res, next) {
  try {
    const resolvedStreamId = await resolveOptionalStreamId(
      req.query.streamId,
      req.query.title
    );
    const { rows } = await db.query(
      `SELECT n.content, n.stream_timestamp, n.created_at, s.title AS stream_title
       FROM notes n
       LEFT JOIN streams s ON s.id = n.stream_id
       WHERE n.user_id = $1 ${resolvedStreamId ? 'AND n.stream_id = $2' : ''}
       ORDER BY n.created_at ASC`,
      resolvedStreamId ? [dbUserId(req), resolvedStreamId] : [dbUserId(req)]
    );

    const doc = new PDFDoc({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="notes.pdf"`);
    doc.pipe(res);

    const streamTitle = rows[0]?.stream_title || 'All Streams';
    doc.fontSize(18).font('Helvetica-Bold').text(`My Notes — ${streamTitle}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica').fillColor('#888')
      .text(`Exported on ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    rows.forEach((n, i) => {
      const ts   = n.stream_timestamp != null ? ` [${formatTimestamp(n.stream_timestamp)}]` : '';
      const date = new Date(n.created_at).toLocaleString();

      doc.fontSize(9).fillColor('#999').text(`${date}${ts}`);
      doc.fontSize(11).fillColor('#111').text(n.content);
      if (i < rows.length - 1) {
        doc.moveDown(0.5)
           .strokeColor('#ddd').lineWidth(0.5)
           .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.5);
      }
    });

    doc.end();
  } catch (err) {
    next(err);
  }
}

// helpers
function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

module.exports = { createNote, getNotes, getNote, updateNote, deleteNote, exportText, exportPDF };
