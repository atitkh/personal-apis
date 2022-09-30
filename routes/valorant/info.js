const router = require('express').Router();
const fetch = require('node-fetch');
const axios = require('axios');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Valorant API');
});

// get cookie
router.get('/getCookie', async (req, res) => {
    const postData = {
        client_id: "play-valorant-web-prod",
        nonce: "1",
        redirect_uri: "https://playvalorant.com/opt_in",
        response_type: "token id_token"
    }
    const cookie = await axios.post('https://auth.riotgames.com/api/v1/authorization', postData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'RiotClient/43.0.1.4195386.4190634 rso-auth (Windows;10;;Professional, x64)',
                "Access-Control-Allow-Origin": "*"
            }
        }
    ).then(response => {
        res.send(response.data.response.parameters.cookie);
    }).catch(err => {
        res.send(err);
    });
});

module.exports = router;