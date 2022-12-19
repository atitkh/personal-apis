const router = require('express').Router();
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Portfolio API');
});

// get json data from atit.json file to variable
router.get('/atit', (req, res) => {
    const atitPortfolio = require('./atit.json');
    res.json(atitPortfolio);
});


module.exports = router;