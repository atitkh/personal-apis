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
        console.log(address);
        
        //make api call to nftport.xyz

    } else {
        res.status(400).send('Address is required');
    }
} );

module.exports = router;