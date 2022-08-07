const router = require('express').Router();
const verify = require('../auth/verifyToken');


router.get('/', (req, res) => {
    res.send('Welcome to NFT Search API');
});

router.get('/all', verify, (req, res) => {
    assets = [];
});

module.exports = router;