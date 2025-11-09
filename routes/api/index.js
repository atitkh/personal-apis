const express = require('express');
const router = express.Router();

// Import versioned routes
const v1Routes = require('./v1');

// Mount v1 routes
router.use('/v1', v1Routes);

// Default version (redirect to v1)
router.use('/', v1Routes);

module.exports = router;