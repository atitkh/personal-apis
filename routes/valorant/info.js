const router = require('express').Router();
const fetch = require('node-fetch');
const axios = require('axios');
const verify = require('../auth/verifyToken');
const Valorant = require('./valorant');
const HenrikDevValorantAPI = require('unofficial-valorant-api');
const VAPI = new HenrikDevValorantAPI();

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

// get user's active game data
router.post('/activegame/:type', async (req, res) => {
    const type = req.params.type;
    const { access_token, entitlements_token, user_id, username, region } = req.body;
    const valorantApi = new Valorant.API(region);
    players = [];
    matchID = "";
    matchData = {};
    matchLoadout = [];
    var eloData = {};

    if (!access_token || !entitlements_token || !user_id || !username || !region) {
        return res.status(400).send('Please enter all the required fields');
    }

    valorantApi.access_token = access_token;
    valorantApi.entitlements_token = entitlements_token;
    valorantApi.user_id = user_id;

    // get match id
    await fetch(`https://glz-ap-1.ap.a.pvp.net/core-game/v1/players/${user_id}`, {
        method: 'GET',
        headers: valorantApi.generateRequestHeaders()
    }).then(response => response.json())
        .then(data => {
            matchID = data.MatchID;
        }).catch((error) => {
            console.log(error)
            res.status(403).send(error);
        });

    // get match data and save player ids
    await fetch(`https://glz-ap-1.ap.a.pvp.net/core-game/v1/matches/${matchID}`, {
        method: 'GET',
        headers: valorantApi.generateRequestHeaders()
    }).then(response => response.json())
        .then(data => {
            players = data.Players;
            matchData = data;
        }
        ).catch((error) => {
            console.log(error)
            res.status(403).send(error);
        });

    // get match loadout
    if(matchID != ""){
        await fetch(`https://glz-ap-1.ap.a.pvp.net/core-game/v1/matches/${matchID}/loadouts`, {
            method: 'GET',
            headers: valorantApi.generateRequestHeaders(),
        }).then(response => response.json())
            .then(data => {
                matchLoadout = data.Loadouts;
            }).catch((error) => {
                console.log(error);
            });
        }

    // clean loadout data
    for (var i = 0; i < matchLoadout.length; i++) {
        var playerLoadout = [];
        for (var j = 0; j < Object.keys( matchLoadout[i].Loadout.Items ).length; j++) {
            var item = matchLoadout[i].Loadout.Items[Object.keys( matchLoadout[i].Loadout.Items )[j]];
            var weaponID = item.ID;
            var weaponSkinID = item.Sockets["bcef87d6-209b-46c6-8b19-fbe40bd95abc"].Item.ID;
            var weaponChroma = item.Sockets["3ad1b2b2-acdb-4524-852f-954a76ddae0a"].Item.ID;

            // // get skin details
            var skinDetails = await fetch("https://valorant-api.com/v1/weapons/skins/" + weaponSkinID);
            skinDetails = await skinDetails.json();
            skinDetails = skinDetails.data;
            var skinName = skinDetails.displayName;

            // // filter weaponChroma from skinDetails.data.chromas array
            var chromaImg = skinDetails.chromas.filter((chroma) => {
                return chroma.uuid === weaponChroma;
            })[0].displayIcon;

            if (chromaImg === null) {
                chromaImg = skinDetails.displayIcon;
            }

            var itemsData = {
                weaponName: skinName,
                weaponImg: chromaImg
            }

            playerLoadout.push(itemsData);
        }
        players[i].Loadout = playerLoadout;
    }

    for (var i = 0; i < players.length; i++) {
            players[i].LoadoutIDs = matchLoadout[i].Loadout;
    }

    // get each player data
    if (players) {
        for (var i = 0; i < players.length; i++) {
            // data = await valorantApi.getPlayerMMR(players[i].Subject)
            // data = (data.data);
            // console.log(mmr_data);
            // if (data.LatestCompetitiveUpdate) {
            //     const update = data.LatestCompetitiveUpdate;
            //     var elo = calculateElo(update.TierAfterUpdate, update.RankedRatingAfterUpdate);
            //     eloData = {
            //         "Movement": update.CompetitiveMovement,
            //         "CurrentTierID": update.TierAfterUpdate,
            //         "CurrentTierName": (Valorant.Tiers[update.TierAfterUpdate]),
            //         "CurrentTierProgress": update.RankedRatingAfterUpdate,
            //         "TotalElo": elo
            //     }
            // } else {
            //     console.log("No competitive update available. Have you played a competitive match yet?");
            // }

            // get playercard img url
            var playerCard = await fetch(`https://valorant-api.com/v1/playercards/${players[i].PlayerIdentity.PlayerCardID}`);
            playerCard = await playerCard.json();
            playerCard = playerCard.data;
            players[i].PlayerIdentity = {
                ...players[i].PlayerIdentity,
                PlayerCard: playerCard
            }

            // get mmr data
            mmr_data = await VAPI.getMMRByPUUID({
                version: 'v1',
                region: 'ap',
                puuid: players[i].Subject
            });
            mmr_data = mmr_data.data;
            if (mmr_data) {
                players[i] = {
                    ...players[i],
                    Elo: mmr_data
                }
            }
            else {
                // add new key to player object
                players[i] = {
                    ...players[i],
                    Elo: {
                        "Movement": "NONE",
                        "CurrentTierID": 0,
                        "CurrentTierName": "Unrated",
                        "CurrentTierProgress": 0,
                        "TotalElo": 0,
                        "images" : {
                            "large" : "https://media.valorant-api.com/competitivetiers/564d8e28-c226-3180-6285-e48a390db8b1/0/largeicon.png"
                        }
                    }
                }
            }
        }

        matchData = {
            ...matchData,
            Players: players
        }

        if (type == "match") {
            res.send(matchData);
        }
        else if (type == "players") {
            res.send(players);
        }
    }
    else {
        res.send(matchData);
    }
});

router.post('/test', async (req, res) => {
    const type = req.params.type;
    const { access_token, entitlements_token, user_id, username, region } = req.body;
    const valorantApi = new Valorant.API(region);

    if (!access_token || !entitlements_token || !user_id || !username || !region) {
        return res.status(400).send('Please enter all the required fields');
    }

    valorantApi.access_token = access_token;
    valorantApi.entitlements_token = entitlements_token;
    valorantApi.user_id = user_id;

    await fetch(`https://glz-ap-1.ap.a.pvp.net/core-game/v1/matches/fb336a4b-e0ec-40c1-ad8a-72fbaa2c8db6/loadouts`, {
        method: 'GET',
        headers: valorantApi.generateRequestHeaders(),
        // body: JSON.stringify(require('./loadout/ruin.json'))
    }).then(response => response.json())
        .then(data => {
            res.send(data);
        }).catch((error) => {
            console.log(error)
            res.status(403).send(error);
        });
});

function calculateElo(tier, progress) {
    if (tier >= 24) {
        return 2100 + progress
    } else {
        return ((tier * 100) - 300) + progress;
    }
}

module.exports = router;