const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/auth/url', authController.getAuthUrl);
router.get('/auth/callback', authController.handleCallback);
router.post('/auth/logout', authMiddleware, authController.logout);
router.get('/auth/user', authMiddleware, authController.getCurrentUser);

module.exports = router;
