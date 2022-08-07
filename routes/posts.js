const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const verify = require('./auth/verifyToken');

//get all posts
router.get('/', verify, async (req, res) => {
    try {
        const posts = await Post.find();
        res.json(posts);
    }
    catch (err) {
        res.json({ message: err });
    }
});

//submit a post
router.post('/', verify, async (req, res) => {
    const post = new Post({
        title: req.body.title,
        description: req.body.description
    });

    try {
        const savedPost = await post.save();
        res.json(savedPost);
    } catch (err) {
        res.json({ message: err.message });
    }
});

//specific post
router.get('/:postId', verify, async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);
        res.json(post);
    }
    catch (err) {
        res.json({ message: err });
    }
});

//delete a post
router.delete('/:postId', verify, async (req, res) => {
    try {
        const removedPost = await Post.remove({ _id: req.params.postId });
        res.json(removedPost);
    }
    catch (err) {
        res.json({ message: err });
    }
});

//update a post
router.patch('/:postId', verify, async (req, res) => {
    try {
        const updatedPost = await Post.updateOne(
            { _id: req.params.postId },
            { $set: { title: req.body.title } }
        );
        res.json(updatedPost);
    }
    catch (err) {
        res.json({ message: err });
    }
});

module.exports = router;