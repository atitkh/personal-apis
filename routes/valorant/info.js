const router = require('express').Router();
const fetch = require('node-fetch');
const axios = require('axios');
const verify = require('../auth/verifyToken');
const Valorant = require('./valorant');

router.get('/', (req, res) => {
    res.send('Welcome to Valorant API');
});

// authenticate user
router.post('/auth', async (req, res) => {
    const valorantApi = new Valorant.API(Valorant.Regions.AsiaPacific);
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).send('Please enter username and password');
    }

    valorantApi.authorize(username, password).then(async () => {
        var data = {
            "access_token": valorantApi.access_token,
            "entitlements_token": valorantApi.entitlements_token,
            "user_id": valorantApi.user_id,
            "username": username,
            "region": valorantApi.region
        }

        res.send(data);
    }).catch((error) => {
        var data = {
            "message": "Error Occured. Please try again."
        }
        console.log(error)
        res.status(403).send(data);
    });
});

router.post('/getHeader', async (req, res) => {
    const { access_token, entitlements_token, user_id, username, region } = req.body;
    const valorantApi = new Valorant.API(region);

    if (!access_token || !entitlements_token || !user_id || !username || !region) {
        return res.status(400).send('Please enter all the required fields');
    }

    valorantApi.access_token = access_token;
    valorantApi.entitlements_token = entitlements_token;
    valorantApi.user_id = user_id;
    valorantApi.username = username;

    const header = valorantApi.generateRequestHeaders()
    res.header(header).send("check header");
});

// get store front of user 
router.post('/storefront', async (req, res) => {
    const { access_token, entitlements_token, user_id, username, region } = req.body;
    const valorantApi = new Valorant.API(region);

    if (!access_token || !entitlements_token || !user_id || !username || !region) {
        return res.status(400).send('Please enter all the required fields');
    }

    valorantApi.access_token = access_token;
    valorantApi.entitlements_token = entitlements_token;
    valorantApi.user_id = user_id;

    await fetch(valorantApi.getPlayerDataServiceUrl(region) + `/store/v2/storefront/${user_id}`, {
        method: 'GET',
        headers: valorantApi.generateRequestHeaders()
    }).then(response => response.json())
        .then(data => {
            res.send(data);
        }).catch((error) => {
            console.log(error)
            res.status(403).send(error);
        });

});

//get wallet info 
router.post('/wallet', async (req, res) => {
    const { access_token, entitlements_token, user_id, username, region } = req.body;
    const valorantApi = new Valorant.API(region);

    if (!access_token || !entitlements_token || !user_id || !username || !region) {
        return res.status(400).send('Please enter all the required fields');
    }

    valorantApi.access_token = access_token;
    valorantApi.entitlements_token = entitlements_token;
    valorantApi.user_id = user_id;

    await fetch(valorantApi.getPlayerDataServiceUrl(region) + `/store/v1/wallet/${user_id}`, {
        method: 'GET',
        headers: valorantApi.generateRequestHeaders()
    }).then(response => response.json())
        .then(data => {
            res.send(data);
        }).catch((error) => {
            console.log(error)
            res.status(403).send(error);
        });

});

module.exports = router;