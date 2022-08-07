const router = require('express').Router();
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Smart Home API');
});

module.exports = router;