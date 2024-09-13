const router = require('express').Router();
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Portfolio API');
});

router.get('/atit', (req, res) => {
    const atitPortfolio = require('./atit/atit.json');
    res.json(atitPortfolio);
});

router.get('/atit/md', (req, res) => {
    const id = req.query.id;
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'atit', 'md', id + '.md');
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error');
        }
        res.send(data);
    });
});

router.get('/ashlesha', (req, res) => {
    const ashleshaPortfolio = require('./ashlesha/ashlesha.json');
    res.json(ashleshaPortfolio);
});


module.exports = router;