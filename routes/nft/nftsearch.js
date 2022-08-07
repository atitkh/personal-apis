const router = require('express').Router();
const fetch = require('node-fetch');
const verify = require('../auth/verifyToken');

router.get('/', (req, res) => {
    res.send('Welcome to NFT Search API');
});

// all nft listings
router.get('/all', verify, async (req, res) => {
    assets = [];
    if (req.query.address) {
        try {
            address = req.query.address;

            //polygon chain 
            let url = `https://api.nftport.xyz/v0/accounts/${address}?chain=polygon`;
            let options = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `${process.env.NFTPORTAL_KEY}`
                }
            };

            //ethereum chain 
            let url2 = `https://api.nftport.xyz/v0/accounts/${address}?chain=ethereum&include=metadata`;
            let options2 = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `${process.env.NFTPORTAL_KEY}`
                }
            };

            let response_polygon = await fetch(url, options);
            let response_ethereum = await fetch(url2, options2);

            let nfts_polygon = await response_polygon.json();
            let nfts_ethereum = await response_ethereum.json();

            let data_polygon = nfts_polygon.nfts;
            let data_ethereum = nfts_ethereum.nfts;

            for (let i = 0; i < data_polygon.length; i++) {
                let nft = data_polygon[i];
                if (nft.file_url) {
                    nft.file_url = ipfsChecker(nft.file_url);
                }
                assets.push(nft);
            }

            for (let j = 0; j < data_ethereum.length; j++) {
                let nft = data_ethereum[j];
                if (nft.file_url) {
                    nft.file_url = ipfsChecker(nft.file_url);
                }
                assets.push(nft);
            }

            total_nfts = assets.length;
            assets.push({ "total_nfts" : total_nfts });

            res.send(assets);
        } catch (error) {
            res.send(error);
        }

    } else {
        res.status(400).send('Address is required');
    }
});

// polygon chain only
router.get('/polygon', verify, async (req, res) => {
    assets = [];
    if (req.query.address) {
        try {
            address = req.query.address;

            //polygon chain 
            let url = `https://api.nftport.xyz/v0/accounts/${address}?chain=polygon`;
            let options = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `${process.env.NFTPORTAL_KEY}`
                }
            };

            let response_polygon = await fetch(url, options);
            let nfts_polygon = await response_polygon.json();
            let data_polygon = nfts_polygon.nfts;

            for (let i = 0; i < data_polygon.length; i++) {
                let nft = data_polygon[i];
                if (nft.file_url) {
                    nft.file_url = ipfsChecker(nft.file_url);
                }
                assets.push(nft);
            }

            total_nfts = assets.length;
            assets.push({ "total_nfts" : total_nfts });

            res.send(assets);
        } catch (error) {
            res.send(error);
        }

    } else {
        res.status(400).send('Address is required');
    }
});

//etherum chain only
router.get('/ethereum', verify, async (req, res) => {
    assets = [];
    if (req.query.address) {
        try {
            address = req.query.address;

            //ethereum chain 
            let url = `https://api.nftport.xyz/v0/accounts/${address}?chain=ethereum&include=metadata`;
            let options = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `${process.env.NFTPORTAL_KEY}`
                }
            };

            let response_ethereum = await fetch(url, options);
            let nfts_ethereum = await response_ethereum.json();
            let data_ethereum = nfts_ethereum.nfts;

            for (let i = 0; i < data_ethereum.length; i++) {
                let nft = data_ethereum[i];
                if (nft.file_url) {
                    nft.file_url = ipfsChecker(nft.file_url);
                }
                assets.push(nft);
            }

            total_nfts = assets.length;
            assets.push({ "total_nfts" : total_nfts });

            res.send(assets);
        } catch (error) {
            res.send(error);
        }

    } else {
        res.status(400).send('Address is required');
    }
});

function ipfsChecker(url) {
    if (url.includes('ipfs://')) {
        let newUrl = url.replace(/^ipfs:\/\//g, 'https://ipfs.io/ipfs/');
        console.log(newUrl);
        return newUrl;
    } else {
        console.log('No IPFS link found');
        return url;
    }
}

module.exports = router;