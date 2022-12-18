const router = require('express').Router();
const fetch = require('node-fetch');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send("Welcome to Karun's API");
});

module.exports = router;