const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv/config');

//Import Routes
const authRoute = require('./routes/auth/auth');
const ewelinkRoute = require('./routes/smarthome/ewelink');
const magichomeRoute = require('./routes/smarthome/magichome');
const nftlisterRoute = require('./routes/nft/nftsearch');
const phonecallRoute = require('./routes/phonecall/phonecallIFTTT');

//Middleware
app.use(cors());
app.use(express.json());
app.use('/auth', authRoute);
app.use('/smarthome/ewelink', ewelinkRoute);
app.use('/smarthome/magichome', magichomeRoute);
app.use('/nft', nftlisterRoute);
app.use('/phonecall', phonecallRoute);

//main route
app.get('/', (req, res) => {
    res.setHeader('Content-type','text/html')
    res.send(`<h1> Welcome to AK API </h1>
    <p>Following endpoints are currently available:</p>
    <ul>
        <li>/auth/register</li>
        <li>/auth/login</li>
        <li>/smarthome/ewelink</li>
        <li>/smarthome/magichome</li>
        <li>/nft</li>
            <ul>
                <li>/nft/all</li>
                <li>/nft/polygon</li>
                <li>/nft/ethereum</li>
            </ul>
        </ul>`);
});

//Connect to DB
mongoose.connect(process.env.DB_CONNECTION, { }, () => {
    console.log('Connected to DB');
});

//listen
const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});
