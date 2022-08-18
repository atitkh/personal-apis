const router = require('express').Router();
const fetch = require('node-fetch');
const sharp = require('sharp');
const axios = require('axios');
const verify = require('../auth/verifyToken');
const { func, ref } = require('joi');
const { syncBuiltinESMExports } = require('module');

router.get('/', (req, res) => {
    res.send('Welcome to NFT Search API');
});

// all nft listings
router.get('/all', async (req, res) => {
    var assets = [];
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
router.get('/polygon', async (req, res) => {
    var assets = [];
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
router.get('/ethereum', async (req, res) => {
    var assets = [];
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

router.get('/base64', async (req, res) => {
    var assets = [];
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


            console.log('asset ready')
            var refined = await new Promise(function(myResolve, myReject) {
                refineBase64(myResolve, assets);
            });

            console.log('received refined assets')

            res.send(refined);
        } catch (error) {
            res.send(error);
        }
    } else {
        res.status(400).send('Address is required');
    }
});

async function refineBase64(myResolve, array) {
    var count = 0;
    for(const nft of array) {
        var name = nft.name;
        var file_url = nft.file_url;

        if (file_url && count < 15) {
            var base64 = await sharpImg(file_url);
            // refined.push(JSON.stringify({ "name" : name, "base64" : base64 }));
            nft["base64"] = base64;
        }
        count++;
    }
    console.log('done refining');
    myResolve(array);
}

function ipfsChecker(url) {
    if (url.includes('ipfs://')) {
        let newUrl = url.replace(/^ipfs:\/\//g, 'https://cloudflare-ipfs.com/ipfs/');
        return newUrl;
    } else {
        return url;
    }
}

async function sharpImg(url) {
    try {
        let res = await axios({ url, responseType: "arraybuffer" });
        var buffer = Buffer.from(res.data, 'binary');

        var data = await sharp(buffer)
            .resize(200)
            .toFormat('jpeg')
            .jpeg({
            quality: 100,
            chromaSubsampling: '4:4:4',
            force: true,
            })
            .toBuffer()
            .then(resizedImageBuffer => {
                let resizedImageData = resizedImageBuffer.toString('base64');
                return resizedImageData;
            })
            .catch(error => {
                // error handeling
                return error;
            })
        return data;
    }
    catch (error) {
        console.log(error);
        return 'error';
    }    
}

module.exports = router;