const express = require('express');
const app = express();
const mongoose = require('mongoose');

//Routes
app.get('/', (req, res) => {
    res.send('Hello World!!');
});

app.get('/posts', (req, res) => {
    res.send('Posts');
});

//Connect to DB
mongoose.connect('mongodb+srv://admin:<password>@rest.loxeqmk.mongodb.net/?retryWrites=true&w=majority');


//listen
app.listen(3000, () => {
    console.log('Listening on port 3000');
});
