const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

router.post('/webhook/bling', webhookController.handleBlingWebhook);
router.get('/webhook/bling', webhookController.getWebhookStatus);

module.exports = router;
