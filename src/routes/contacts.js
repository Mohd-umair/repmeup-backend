const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  mergeContact
} = require('../controllers/contactController');

router.use(protect);

router.get('/', authorize('admin', 'manager', 'agent'), getContacts);
router.get('/:id', authorize('admin', 'manager', 'agent'), getContact);
router.put('/:id', authorize('admin', 'manager'), updateContact);
router.delete('/:id', authorize('admin', 'manager'), deleteContact);
router.post('/:id/merge', authorize('admin', 'manager'), mergeContact);

module.exports = router;
