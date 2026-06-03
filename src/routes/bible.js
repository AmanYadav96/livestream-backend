const router = require('express').Router();
const ctrl   = require('../controllers/bibleController');
const { authenticate, requireHost } = require('../middleware/auth');

// ── Public — no auth needed ───────────────────────────────────────────────────
router.get('/verse-of-the-day',          ctrl.getVerseOfTheDay);   // ?version_id=1
router.get('/versions',                  ctrl.getVersions);         // list all Bible versions
router.get('/search',                    ctrl.searchVerses);         // ?q=love&version_id=1
router.get('/verses/:usfm',             ctrl.getVerse);             // ?version_id=1  e.g. JHN.3.16
router.get('/chapters/:usfm',           ctrl.getChapter);           // ?version_id=1  e.g. JHN.3

// ── Authenticated — personal saved verses ────────────────────────────────────
router.use(authenticate);
router.get   ('/saved',      ctrl.getSavedVerses);
router.post  ('/saved',      ctrl.saveVerse);
router.delete('/saved/:id',  ctrl.deleteSavedVerse);

// ── Host only — push verse live to all stream viewers ─────────────────────────
router.post('/:streamId/push',   requireHost, ctrl.pushVerse);
router.get ('/:streamId/pushed',             ctrl.getPushedVerses);

module.exports = router;
