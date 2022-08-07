const router = require('express').Router();
const userModel = require('../../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { registerValidation, loginValidation } = require('../../validation');

//register user
router.post('/register', async (req, res) => {
    //validate the data
    const { error } = registerValidation(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    //check if email existes 
    const emailExists = await userModel.findOne({ email: req.body.email });
    if (emailExists) return res.status(400).send('Email already exists.');

    //hashing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(req.body.password, salt);    

    res.status(400).send('User registration is disabled at the moment.');
    // const user = new userModel({
    //     name: req.body.name,
    //     email: req.body.email,
    //     password: hashedPassword
    // });
    // try {
    //     const savedUser = await user.save();
    //     res.send({ user: user._id });
    // }
    // catch (err) {
    //     res.status(400).send(err);
    // }
});

//login
router.post('/login', async (req, res) => {
    //validate the data
    const { error } = loginValidation(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    //check if email exists
    const user = await userModel.findOne({ email: req.body.email });
    if (!user) return res.status(400).send('Email or password is incorrect.');

    //check if password is correct
    const validPassword = await bcrypt.compare(req.body.password, user.password);
    if (!validPassword) return res.status(400).send('Email or password is incorrect.');

    //create and assign a token
    const token = jwt.sign({ _id: user._id }, process.env.TOKEN_SECRET);
    res.header('auth-token', token);

    res.send('Logged in successfully.');
});

module.exports = router;