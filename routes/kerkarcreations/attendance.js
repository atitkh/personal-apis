const router = require('express').Router();
const { requireScope } = require('../../middleware/apiKey');
const { google } = require('googleapis');

// The Sheets client is built on first use, so a missing service-account key no longer stops the whole
// server from booting (the portfolio shares this process).
let client = null;
function getClient() {
    if (!client) {
        client = new google.auth.JWT(
            process.env.SA_EMAIL,
            null,
            (process.env.SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
            ['https://www.googleapis.com/auth/spreadsheets']
        );
    }
    return client;
}

router.get('/', (req, res) => {
    res.send("Welcome to Kerkar Creations' Attendance API");
});

router.get('/get', requireScope('attendance:read'), (req, res) => {
    getClient().authorize(function (err, tokens) {
        if (err) {
            console.log(err);
            res.status(500).send('Error');
            return;
        } else {
            console.log('Connected to Sheets!');
            gsrun(getClient());
        }
    });

    async function gsrun(cl) {
        const gsapi = google.sheets({ version: 'v4', auth: cl });

        const optGet = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G'
        };

        let data = await gsapi.spreadsheets.values.get(optGet);
        let dataArray = data.data.values;
        let jsonData = [];

        if(dataArray){
            for (let i = 0; i < dataArray.length; i++) {
                jsonData.push({
                    'Name': dataArray[i][0],
                    'Date': dataArray[i][1],
                    'Time': dataArray[i][2]
                });
            }
        }

        res.json(jsonData);
    }
});

// get by name
router.get('/get/:name', requireScope('attendance:read'), (req, res) => {
    getClient().authorize(function (err, tokens) {
        if (err) {
            console.log(err);
            res.status(500).send('Error');
            return;
        } else {
            console.log('Connected to Sheets!');
            gsrun(getClient());
        }
    });

    async function gsrun(cl) {
        const gsapi = google.sheets({ version: 'v4', auth: cl });

        const optGet = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G'
        };

        let data = await gsapi.spreadsheets.values.get(optGet);
        let dataArray = data.data.values;
        let jsonData = [];

        if (dataArray) {
            for (let i = 0; i < dataArray.length; i++) {
                if (dataArray[i][0] == req.params.name) {
                    jsonData.push({
                        'Name': dataArray[i][0],
                        'Date': dataArray[i][1],
                        'Time': dataArray[i][2]
                    });
                }
            }
        }

        res.json(jsonData);
    }
});


router.post('/add', requireScope('attendance:api-write'), (req, res) => {
    getClient().authorize(function (err, tokens) {
        if (err) {
            console.log(err);
            res.status(500).send('Error');
            return;
        } else {
            console.log('Connected to Sheets!');
            gsrun(getClient());
        }
    });

    async function gsrun(cl) {
        const entry = {
            values: [
                [
                    req.query.name,
                    new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kathmandu' }),
                    new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu' })
                ]
            ]
        }
        
        let isPresent = false;

        const gsapi = google.sheets({ version: 'v4', auth: cl });

        const optAdd = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G',
            valueInputOption: 'USER_ENTERED',
            resource: entry
        };

        const optGet = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G'
        };

        let getData = await gsapi.spreadsheets.values.get(optGet);
        let dataArray = getData.data.values;
        let jsonData = [];

        if(dataArray){
            for (let i = 0; i < dataArray.length; i++) {
                jsonData.push({
                    'Name': dataArray[i][0],
                    'Date': dataArray[i][1],
                    'Time': dataArray[i][2]
                });
            }
        }

        for (let i = 0; i < jsonData.length; i++) {
            if (jsonData[i].Name == req.query.name && jsonData[i].Date == new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kathmandu' })) {
                isPresent = true;
            }
        }

        if (isPresent) {
            res.json({ 'message': 'Attendance already done for today.' });
        }
        else {
            let addData = await gsapi.spreadsheets.values.append(optAdd);
            res.json({ 'message': 'Attendance added.' });
        }
    }
});
        
module.exports = router;