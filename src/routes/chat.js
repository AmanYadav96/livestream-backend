const router  = require('express').Router();
const ctrl    = require('../controllers/chatController');
const { authenticate, requireHost } = require('../middleware/auth');
const { chatLimiter } = require('../middleware/rateLimiter');

// All routes require authentication
router.use(authenticate);

// Chat history & pinned
router.get('/:streamId/messages',           ctrl.getHistory);
router.get('/:streamId/messages/pinned',    ctrl.getPinned);

// Moderation — host/admin only
router.patch('/:streamId/messages/:messageId/pin',    requireHost, ctrl.pinMessage);
router.patch('/:streamId/messages/:messageId/unpin',  requireHost, ctrl.unpinMessage);
router.delete('/:streamId/messages/:messageId',       requireHost, ctrl.deleteMessage);

// Mute management
router.get   ('/:streamId/muted',    requireHost, ctrl.getMutedUsers);
router.post  ('/:streamId/mute',     requireHost, ctrl.muteUser);
router.post  ('/:streamId/unmute',   requireHost, ctrl.unmuteUser);

module.exports = router;
