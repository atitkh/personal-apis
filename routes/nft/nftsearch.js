const router = require('express').Router();
const fetch = require('node-fetch');
const verify = require('../auth/verifyToken');


router.get('/', (req, res) => {
    res.send('Welcome to NFT Search API');
});

router.get('/all', verify, (req, res) => {
    assets = [{'polygon':''},
    {'ethereum':''}];
    if(req.query.address) {
        address = req.query.address;
        let url = `https://api.nftport.xyz/v0/accounts/${address}`;
        let options = {
            method: 'GET',
            qs: {chain: 'polygon'},
            headers: {
              'Content-Type': 'application/json',
              Authorization: `${process.env.NFTPORTAL_KEY}`
            }
          };

        fetch(url, options)
        .then(res => res.json())
        .then(json => {
            assets.polygon = json.nfts;
            console.log(assets.polygon);
        })
        .catch(err => console.error('error:' + err));
        
        //make api call to nftport.xyz

    } else {
        res.status(400).send('Address is required');
    }
} );

module.exports = router;