const express = require('express');
const router = express.Router();
const {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserStats,
  getAvailableAgents
} = require('../controllers/userController');
const { protect } = require('../middlewares/auth');

// All routes require authentication
router.use(protect);

// GET /api/users/agents/available - Get available agents for assignment
router.get('/agents/available', getAvailableAgents);

// GET /api/users/:id/stats - Get user statistics
router.get('/:id/stats', getUserStats);

// GET /api/users - Get all users
// POST /api/users - Create new user
router.route('/')
  .get(getUsers)
  .post(createUser);

// GET /api/users/:id - Get single user
// PUT /api/users/:id - Update user
// DELETE /api/users/:id - Delete user
router.route('/:id')
  .get(getUserById)
  .put(updateUser)
  .delete(deleteUser);

module.exports = router;

