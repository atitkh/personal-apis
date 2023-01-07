const router = require('express').Router();
const verify = require('../auth/verifyToken');
const { google } = require('googleapis');
const sa_keys = require('./sa_keys.json');


router.get('/', (req, res) => {
    res.send('Welcome to Attendance API');
});

router.get('/getAttendance', verify, (req, res) => {
    const client = new google.auth.JWT(
        process.env.SA_EMAIL,
        null,
        process.env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/spreadsheets']
    );

    client.authorize(function (err, tokens) {
        if (err) {
            console.log(err);
            return;
        } else {
            console.log('Connected!');
            gsrun(client);
        }
    });

    async function gsrun(cl) {
        const gsapi = google.sheets({ version: 'v4', auth: cl });

        const opt = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G'
        };

        let data = await gsapi.spreadsheets.values.get(opt);
        let dataArray = data.data.values;
        let jsonData = [];

        for (let i = 0; i < dataArray.length; i++) {
            jsonData.push({
                'Date': dataArray[i][0],
                'Name': dataArray[i][1],
                'Email': dataArray[i][2],
                'Contact': dataArray[i][3],
                'Address': dataArray[i][4],
                'City': dataArray[i][5],
                'State': dataArray[i][6]
            });
        }

        res.json(jsonData);
    }
});

router.post('/addAttendance', verify, (req, res) => {
    const client = new google.auth.JWT(
        sa_keys.client_email,
        null,
        sa_keys.private_key,
        ['https://www.googleapis.com/auth/spreadsheets']
    );

    client.authorize(function (err, tokens) {
        if (err) {
            console.log(err);
            return;
        } else {
            console.log('Connected!');
            gsrun(client);
        }
    });

    async function gsrun(cl) {
        const gsapi = google.sheets({ version: 'v4', auth: cl });

        const opt = {
            spreadsheetId: process.env.ATTENDANCE_SHEET_ID,
            range: 'Attendance!A2:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['test1', 'test2', 'test3']] }
        };

        let data = await gsapi.spreadsheets.values.append(opt);
        res.json(data);
    }
});
        
module.exports = router;