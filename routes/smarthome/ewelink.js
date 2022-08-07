const router = require('express').Router();
const ewelink = require('ewelink-api');
const verify = require('../auth/verifyToken');

//ewelink api
const ewelinkApi = new ewelink({
    email: process.env.EWELINK_EMAIL,
    password: process.env.EWELINK_PASSWORD,
    region: 'as'
});

router.get('/', (req, res) => {
    res.send('Welcome to Smart Home API');
});

router.get('/devices', verify, async (req, res) => {
    try {
        const devices = await ewelinkApi.getDevices();
        res.json(devices);
    } catch (err) {
        res.json({ message: err });
    }
}).get('/:deviceId', verify, async (req, res) => {
    try {
        const device = await ewelinkApi.getDevice(req.params.deviceId);
        res.json(device);
    } catch (err) {
        res.json({ message: err });
    }
});

module.exports = router;