const express = require('express');
const router = express.Router();
const publicFaqController = require('../controllers/publicFaqController');

router.get('/faqs', publicFaqController.listFaqs);

module.exports = router;
