const router = require('express').Router();
const ctrl   = require('../controllers/notesController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get   ('/',            ctrl.getNotes);
router.post  ('/',            ctrl.createNote);
router.get   ('/export/text', ctrl.exportText);
router.get   ('/export/pdf',  ctrl.exportPDF);
router.get   ('/:id',         ctrl.getNote);
router.put   ('/:id',         ctrl.updateNote);
router.delete('/:id',         ctrl.deleteNote);

module.exports = router;
