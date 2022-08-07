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
}).get('/:deviceId/info', verify, async (req, res) => {
    try {
        const device = await ewelinkApi.getDevice(req.params.deviceId);
        res.json(device);
    } catch (err) {
        res.json({ message: err });
    }
});

//tubelight
router.get('/tubelight', verify, async (req, res) => {
    try {
        const action = await ewelinkApi.setDevicePowerState(process.env.TUBELIGHT_ID, "toggle");
        res.json(action.status);
    } catch (err) {
        res.json({ message: err });
    }
});

router.get('/tubelight/:action', verify, async (req, res) => {
    try {
        const action = await ewelinkApi.setDevicePowerState(process.env.TUBELIGHT_ID, req.params.action);
        res.json(action.status);
    } catch (err) {
        res.json({ message: err });
    }
});

module.exports = router;