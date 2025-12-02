const express = require('express');
const voiceController = require('../../../controllers/voiceController');
const { authenticate } = require('../../../middleware/auth');

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     VoiceStatus:
 *       type: object
 *       properties:
 *         whisper:
 *           type: object
 *           properties:
 *             status:
 *               type: string
 *               enum: [available, unavailable]
 *             url:
 *               type: string
 *             model:
 *               type: string
 *             language:
 *               type: string
 *             supportedFormats:
 *               type: array
 *               items:
 *                 type: string
 *         piper:
 *           type: object
 *           properties:
 *             status:
 *               type: string
 *               enum: [available, unavailable]
 *             url:
 *               type: string
 *             defaultVoice:
 *               type: string
 *             availableVoices:
 *               type: array
 *               items:
 *                 type: string
 *         overall:
 *           type: string
 *           enum: [operational, partial]
 *
 *     TranscriptionResult:
 *       type: object
 *       properties:
 *         text:
 *           type: string
 *           description: Transcribed text
 *         language:
 *           type: string
 *           description: Detected language
 *         duration:
 *           type: number
 *           description: Audio duration in seconds
 *         confidence:
 *           type: number
 *           description: Transcription confidence score
 *
 *     VoiceConversationResult:
 *       type: object
 *       properties:
 *         transcription:
 *           $ref: '#/components/schemas/TranscriptionResult'
 *         response:
 *           type: string
 *           description: AI response text
 *         conversation_id:
 *           type: string
 *         audio:
 *           type: object
 *           properties:
 *             data:
 *               type: string
 *               description: Base64 encoded audio data
 *             contentType:
 *               type: string
 *             format:
 *               type: string
 *             voice:
 *               type: string
 *         metadata:
 *           type: object
 */

/**
 * @swagger
 * /api/v1/voice/status:
 *   get:
 *     summary: Get voice services status
 *     description: Check the health and availability of Whisper and Piper services
 *     tags: [Voice]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Voice services status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/VoiceStatus'
 */
router.get('/status', authenticate, voiceController.getStatus);

/**
 * @swagger
 * /api/v1/voice/speech-to-text:
 *   post:
 *     summary: Convert speech to text
 *     description: Upload an audio file and get the transcribed text using Whisper
 *     tags: [Voice]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - audio
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *                 description: Audio file (wav, mp3, ogg, flac, m4a, webm)
 *               language:
 *                 type: string
 *                 description: Language code (e.g., 'en', 'es', 'fr') or 'auto' for detection
 *                 default: auto
 *               model:
 *                 type: string
 *                 description: Whisper model to use
 *                 enum: [tiny, base, small, medium, large]
 *                 default: base
 *               temperature:
 *                 type: number
 *                 description: Sampling temperature (0.0 to 1.0)
 *                 minimum: 0
 *                 maximum: 1
 *               response_format:
 *                 type: string
 *                 description: Response format
 *                 enum: [json, text, srt, verbose_json, vtt]
 *                 default: json
 *     responses:
 *       200:
 *         description: Speech successfully converted to text
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TranscriptionResult'
 */
router.post('/speech-to-text', authenticate, voiceController.getUploadMiddleware(), voiceController.speechToText);

/**
 * @swagger
 * /api/v1/voice/text-to-speech:
 *   post:
 *     summary: Convert text to speech
 *     description: Convert text to speech audio using Piper
 *     tags: [Voice]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - text
 *             properties:
 *               text:
 *                 type: string
 *                 description: Text to convert to speech
 *                 maxLength: 5000
 *               voice:
 *                 type: string
 *                 description: Voice model to use
 *                 default: en_US-amy-medium
 *               speed:
 *                 type: number
 *                 description: Speech speed multiplier
 *                 minimum: 0.1
 *                 maximum: 3.0
 *                 default: 1.0
 *               output_format:
 *                 type: string
 *                 description: Audio output format
 *                 enum: [wav, mp3]
 *                 default: wav
 *               speaker_id:
 *                 type: integer
 *                 description: Speaker ID for multi-speaker voices
 *               noise_scale:
 *                 type: number
 *                 description: Noise scale for voice variability
 *                 minimum: 0.0
 *                 maximum: 1.0
 *               length_scale:
 *                 type: number
 *                 description: Length scale for speech duration
 *                 minimum: 0.1
 *                 maximum: 2.0
 *     responses:
 *       200:
 *         description: Text successfully converted to speech
 *         content:
 *           audio/wav:
 *             schema:
 *               type: string
 *               format: binary
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 */
router.post('/text-to-speech', authenticate, voiceController.textToSpeech);

/**
 * @swagger
 * /api/v1/voice/voices:
 *   get:
 *     summary: Get available voices
 *     description: Retrieve list of available voices from Piper
 *     tags: [Voice]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Available voices retrieved
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
 *                     voices:
 *                       type: array
 *                       items:
 *                         type: string
 */
router.get('/voices', authenticate, voiceController.getVoices);

/**
 * @swagger
 * /api/v1/voice/chat:
 *   post:
 *     summary: Voice conversation with AI
 *     description: Complete voice interaction - upload audio, get transcription, AI response, and speech synthesis
 *     tags: [Voice]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - audio
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *                 description: Audio file with voice input
 *               conversation_id:
 *                 type: string
 *                 description: Conversation ID for continuity
 *               context:
 *                 type: string
 *                 description: JSON string with additional context
 *               debug:
 *                 type: boolean
 *                 description: Include debug information
 *                 default: false
 *               input_language:
 *                 type: string
 *                 description: Input audio language
 *                 default: auto
 *               whisper_model:
 *                 type: string
 *                 description: Whisper model for transcription
 *                 default: base
 *               output_voice:
 *                 type: string
 *                 description: Voice for AI response
 *                 default: en_US-amy-medium
 *               speech_speed:
 *                 type: number
 *                 description: Speech synthesis speed
 *                 default: 1.0
 *               output_format:
 *                 type: string
 *                 description: Audio output format
 *                 enum: [wav, mp3]
 *                 default: wav
 *     responses:
 *       200:
 *         description: Voice conversation processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/VoiceConversationResult'
 */
router.post('/chat', authenticate, voiceController.getUploadMiddleware(), voiceController.voiceChat);

module.exports = router;