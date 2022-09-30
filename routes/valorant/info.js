const router = require('express').Router();
const fetch = require('node-fetch');
const axios = require('axios');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to Valorant API');
});

// get cookie
router.get('/getCookie', async (req, res) => {
    try {
        const response = await axios.get('https://auth.riotgames.com/api/v1/authorization', {
            headers: {
                'Content-Type': 'application/json',
            },
            params: {
                client_id: 'play-valorant-web-prod',
                nonce: '1',
                redirect_uri: 'https://playvalorant.com/opt_in',
                response_type: 'token id_token',
                }
                });
        const cookie = response.headers['set-cookie'];
        res.send(cookie);
    } catch (error) {
        res.send(error);
    }
});

module.exports = router;