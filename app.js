const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv/config');

//Import Routes
const authRoute = require('./routes/auth/auth');
const ewelinkRoute = require('./routes/smarthome/ewelink');
const magichomeRoute = require('./routes/smarthome/magichome');
const nftlisterRoute = require('./routes/nft/nftsearch');
const phonecallRoute = require('./routes/phonecall/phonecallIFTTT');
const ipoResult = require('./routes/iporesult/iporesult');
const valorantRoute = require('./routes/valorant/info');
const karunRoute = require('./routes/karun/karun');
const portfolioRoute = require('./routes/portfolio/portfolio');

//Middleware
app.use(cors());
app.use(express.json());
app.use('/auth', authRoute);
app.use('/smarthome/ewelink', ewelinkRoute);
app.use('/smarthome/magichome', magichomeRoute);
app.use('/nft', nftlisterRoute);
app.use('/phonecall', phonecallRoute);
app.use('/ipo', ipoResult);
app.use('/valorant', valorantRoute);
app.use('/karun', karunRoute);
app.use('/portfolio', portfolioRoute);

//main route
app.get('/', (req, res) => {
    res.setHeader('Content-type','text/html')
    res.sendFile(path.join(__dirname, '/html/index.html'));
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
