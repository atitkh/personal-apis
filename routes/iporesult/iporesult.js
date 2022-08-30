const router = require('express').Router();
const fetch = require('node-fetch');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to IPO API');
});

// ipo result
router.post('/result', async (req, res) => {
    if (req.query.companyShareId && req.query.boid && req.query.userCaptcha && req.query.captchaIdentifier) {
        try {
            let url = `https://iporesult.cdsc.com.np/result/result/check`;
            let options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    "companyShareId": req.query.companyShareId,
                    "boid": req.query.boid,
                    "userCaptcha": req.query.userCaptcha,
                    "captchaIdentifier": req.query.captchaIdentifier
                })
            };

            let response = await fetch(url, options);
            let data = await response.json();
            res.send(data);
        } catch (err) {
            res.status(400).send(err);
        }
    } else {
        res.status(400).send('Please provide all the required parameters : companyShareId, boid, userCaptcha, captchaIdentifier');
    }
});

//get new captcha
router.get('/newcaptcha', async (req, res) => {
    try {
        let captchaIdentifier = randomString(20);
        let url = `https://iporesult.cdsc.com.np/result/captcha/reload/${captchaIdentifier}`;
        let options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }
        };

        let response = await fetch(url, options);
        let data = await response.json();
        res.send(data);
    } catch (err) {
        res.status(400).send(err);
    }
});

//get company list
router.get('/companylist', async (req, res) => {
    try {
        let url = `https://iporesult.cdsc.com.np/result/companyShares/fileUploaded`;
        let options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }
        };

        let response = await fetch(url, options);
        let data = await response.json();
        res.send(data);
    } catch (err) {
        res.status(400).send(err);
    }
});


// generate random alpha numeric string
function randomString(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

module.exports = router;