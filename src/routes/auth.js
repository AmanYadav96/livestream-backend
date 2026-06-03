const router = require('express').Router();
const ctrl   = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter }  = require('../middleware/rateLimiter');

router.post('/register', authLimiter, ctrl.register);
router.post('/login',    authLimiter, ctrl.login);
router.get ('/me',       authenticate, ctrl.me);

module.exports = router;
