const router = require('express').Router();
const fetch = require('node-fetch');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Phone Call API');
});

// call us number through IFTTT
router.post('/us', verify, async (req, res) => {
    if (req.body.message) {
        message = req.body.message;
        let url = `https://maker.ifttt.com/trigger/phoneCallUS/json/with/key/${process.env.IFTTT_PHONE_KEY}`;
        let options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "Hello": message
            })
        };
        let response = await fetch(url, options);
        let data = await response;
        res.send(data);
    } else {
        res.send('No phone number provided');
    }
});

module.exports = router;