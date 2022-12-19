const router = require('express').Router();
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Portfolio API');
});

router.get('/atit', (req, res) => {
    const atitPortfolio = require('./atit.json');
    res.json(atitPortfolio);
});

router.get('/ashlesha', (req, res) => {
    const ashleshaPortfolio = require('./ashlesha.json');
    res.json(ashleshaPortfolio);
});


module.exports = router;