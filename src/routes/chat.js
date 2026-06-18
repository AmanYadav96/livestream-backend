const router  = require('express').Router();
const ctrl    = require('../controllers/chatController');
const { authenticate, requireHost } = require('../middleware/auth');
const { resolveStreamParam } = require('../middleware/resolveStream');

const withStream = resolveStreamParam;

// Chat history & pinned (public — read-only, like YouTube live chat)
router.get('/:streamId/messages',           withStream, ctrl.getHistory);
router.get('/:streamId/messages/pinned',    withStream, ctrl.getPinned);

// Authenticated routes below
router.use(authenticate);

// Moderation — host/admin only
router.patch('/:streamId/messages/:messageId/pin',    withStream, requireHost, ctrl.pinMessage);
router.patch('/:streamId/messages/:messageId/unpin',  withStream, requireHost, ctrl.unpinMessage);
router.delete('/:streamId/messages/:messageId',       withStream, requireHost, ctrl.deleteMessage);

// Mute management
router.get   ('/:streamId/muted',    withStream, requireHost, ctrl.getMutedUsers);
router.post  ('/:streamId/mute',     withStream, requireHost, ctrl.muteUser);
router.post  ('/:streamId/unmute',   withStream, requireHost, ctrl.unmuteUser);

module.exports = router;
