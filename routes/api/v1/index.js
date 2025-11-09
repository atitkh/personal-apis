const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./auth');
const vortexRoutes = require('./vortex');

// Mount routes
router.use('/auth', authRoutes);
router.use('/vortex', vortexRoutes);

module.exports = router;