const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./auth');
const vortexRoutes = require('./vortex');
const voiceRoutes = require('./voice');

// Mount routes
router.use('/auth', authRoutes);
router.use('/vortex', vortexRoutes);
router.use('/voice', voiceRoutes);

module.exports = router;