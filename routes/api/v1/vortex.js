const express = require('express');
const router = express.Router();
const vortexController = require('../../../controllers/vortexController');
const { authenticate } = require('../../../middleware/auth');
const { validate, schemas } = require('../../../middleware/validation');

/**
 * @swagger
 * tags:
 *   name: Vortex
 *   description: Vortex AI Agent endpoints
 */

/**
 * @swagger
 * /api/v1/vortex/chat:
 *   post:
 *     summary: Chat with Vortex AI
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 2000
 *                 description: Message to send to Vortex
 *               conversation_id:
 *                 type: string
 *                 description: Optional conversation ID for context
 *               context:
 *                 type: object
 *                 description: Additional context information
 *     responses:
 *       200:
 *         description: Vortex response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     response:
 *                       type: string
 *                     conversation_id:
 *                       type: string
 *                     metadata:
 *                       type: object
 *       401:
 *         description: Authentication required
 */
router.post('/chat', authenticate, vortexController.chat);

/**
 * @swagger
 * /api/v1/vortex/debug/chat:
 *   post:
 *     summary: Chat with Vortex AI (Debug Mode)
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 description: Message to send to Vortex
 *               conversation_id:
 *                 type: string
 *                 description: Optional conversation ID for context
 *               context:
 *                 type: object
 *                 description: Additional context information
 *     responses:
 *       200:
 *         description: Vortex response with debug information
 */
router.post('/debug/chat', authenticate, vortexController.debugChat);

/**
 * @swagger
 * /api/v1/vortex/debug/conversation/{conversation_id}:
 *   get:
 *     summary: Debug conversation data
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     parameters:
 *       - in: path
 *         name: conversation_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Conversation ID to debug
 *     responses:
 *       200:
 *         description: Conversation debug data
 */
router.get('/debug/conversation/:conversation_id', authenticate, vortexController.debugConversation);

/**
 * @swagger
 * /api/v1/vortex/test/store:
 *   post:
 *     summary: Test conversation storage
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *               conversation_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Test storage results
 */
router.post('/test/store', authenticate, vortexController.testStoreConversation);

/**
 * @swagger
 * /api/v1/vortex/memory:
 *   get:
 *     summary: Retrieve conversation memory
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     parameters:
 *       - in: query
 *         name: conversation_id
 *         schema:
 *           type: string
 *         description: Specific conversation ID
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [conversation, event, preference, context]
 *         description: Memory type filter
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of memories to retrieve
 *     responses:
 *       200:
 *         description: Memory records retrieved
 */
router.get('/memory', authenticate, vortexController.getMemory);

/**
 * @swagger
 * /api/v1/vortex/memory/browse:
 *   get:
 *     summary: Browse recent memories by type
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [conversations, events, preferences]
 *           default: conversations
 *         description: Memory type to browse
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of memories to retrieve
 *     responses:
 *       200:
 *         description: Recent memories retrieved
 */
router.get('/memory/browse', authenticate, vortexController.browseMemories);

/**
 * @swagger
 * /api/v1/vortex/memory/search:
 *   post:
 *     summary: Search memories using semantic search
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: Search query
 *               type:
 *                 type: string
 *                 enum: [conversations, events, preferences]
 *                 default: conversations
 *               limit:
 *                 type: integer
 *                 default: 20
 *     responses:
 *       200:
 *         description: Matching memories found
 */
router.post('/memory/search', authenticate, vortexController.searchMemories);

/**
 * @swagger
 * /api/v1/vortex/conversation/{conversation_id}/summarize:
 *   post:
 *     summary: Summarize a conversation and extract key information
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     parameters:
 *       - in: path
 *         name: conversation_id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the conversation to summarize
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               forceRegenerate:
 *                 type: boolean
 *                 description: Force regeneration of summary even if one exists
 *     responses:
 *       200:
 *         description: Conversation summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:
 *                   type: string
 *                 facts:
 *                   type: array
 *                   items:
 *                     type: string
 *                 preferences:
 *                   type: array
 *                   items:
 *                     type: string
 *                 tasks:
 *                   type: array
 *                   items:
 *                     type: string
 *                 topics:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/conversation/:conversation_id/summarize', authenticate, vortexController.summarizeConversation);

/**
 * @swagger
 * /api/v1/vortex/memory/intelligence/status:
 *   get:
 *     summary: Get memory intelligence system status
 *     tags: [Vortex]
 *     security:
 *       - authToken: []
 *     responses:
 *       200:
 *         description: Memory intelligence status
 */
router.get('/memory/intelligence/status', authenticate, vortexController.getMemoryIntelligenceStatus);

/**
 * @swagger
 * /api/v1/vortex/status:
 *   get:
 *     summary: Get Vortex system status
 *     tags: [Vortex]
 *     responses:
 *       200:
 *         description: System status information
 */
router.get('/status', vortexController.getStatus);

module.exports = router;