const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv/config');

//Import Routes
const authRoute = require('./routes/auth/auth');
const postsRoute = require('./routes/posts');
const coursesRoute = require('./routes/courses');
const ewelinkRoute = require('./routes/smarthome/ewelink');
const magichomeRoute = require('./routes/smarthome/magichome');

//Middleware
app.use(cors());
app.use(express.json());
app.use('/auth', authRoute);
app.use('/posts', postsRoute);
app.use('/courses', coursesRoute);
app.use('/smarthome/ewelink', ewelinkRoute);
app.use('/smarthome/magichome', magichomeRoute);



//main route
app.get('/', (req, res) => {
    res.send('Welcome to AK API');
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
