const voiceService = require('../services/voiceService');
const vortexService = require('../services/vortexService');
const { logger } = require('../utils/logger');
const multer = require('multer');
const path = require('path');

// Configure multer for audio file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Check file extension
    const allowedExtensions = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format. Allowed formats: ${allowedExtensions.join(', ')}`), false);
    }
  }
});

class VoiceController {
  /**
   * Get voice service status
   */
  async getStatus(req, res, next) {
    try {
      const status = await voiceService.getStatus();
      
      res.success(status, 'Voice service status retrieved');
    } catch (error) {
      logger.error('Voice status check failed', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Convert speech to text using Whisper
   */
  async speechToText(req, res, next) {
    try {
      if (!req.file) {
        return res.error('No audio file provided', 400);
      }

      const options = {
        language: req.body.language,
        model: req.body.model,
        temperature: req.body.temperature ? parseFloat(req.body.temperature) : undefined,
        response_format: req.body.response_format
      };

      logger.info('Processing speech-to-text request', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        filename: req.file.originalname,
        fileSize: req.file.buffer.length,
        options
      });

      const result = await voiceService.speechToText(
        req.file.buffer,
        req.file.originalname,
        options
      );

      res.success(result, 'Speech converted to text successfully');

    } catch (error) {
      logger.error('Speech-to-text conversion failed', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Convert text to speech using Piper
   */
  async textToSpeech(req, res, next) {
    try {
      const { text } = req.body;
      
      if (!text || typeof text !== 'string') {
        return res.error('Text is required', 400);
      }

      const options = {
        voice: req.body.voice,
        speed: req.body.speed ? parseFloat(req.body.speed) : undefined,
        output_format: req.body.output_format,
        speaker_id: req.body.speaker_id ? parseInt(req.body.speaker_id) : undefined,
        noise_scale: req.body.noise_scale ? parseFloat(req.body.noise_scale) : undefined,
        length_scale: req.body.length_scale ? parseFloat(req.body.length_scale) : undefined
      };

      logger.info('Processing text-to-speech request', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        textLength: text.length,
        options
      });

      const result = await voiceService.textToSpeech(text, options);

      // Set appropriate headers for audio response
      res.set({
        'Content-Type': result.contentType,
        'Content-Length': result.audioBuffer.length,
        'Content-Disposition': `inline; filename="speech.${result.format}"`
      });

      res.send(result.audioBuffer);

    } catch (error) {
      logger.error('Text-to-speech conversion failed', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Get available voices from Piper
   */
  async getVoices(req, res, next) {
    try {
      const voices = await voiceService.getAvailableVoices();
      
      res.success({ voices }, 'Available voices retrieved');
    } catch (error) {
      logger.error('Failed to get available voices', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Process voice conversation: audio input -> transcription -> AI response -> speech output
   */
  async voiceChat(req, res, next) {
    try {
      if (!req.file) {
        return res.error('No audio file provided', 400);
      }

      const { conversation_id, context, debug } = req.body;
      const userId = req.user._id || req.user.id;

      // Voice processing options
      const options = {
        inputLanguage: req.body.input_language,
        whisperModel: req.body.whisper_model,
        outputVoice: req.body.output_voice,
        speechSpeed: req.body.speech_speed ? parseFloat(req.body.speech_speed) : undefined,
        outputFormat: req.body.output_format || 'wav',
        startTime: Date.now(),
        chatOptions: {
          conversationId: conversation_id,
          context: {
            ...JSON.parse(context || '{}'),
            source: 'voice-api',
            userAgent: req.get('User-Agent'),
            ip: req.ip,
            user: req.user
          },
          debug: debug === 'true' || debug === true
        }
      };

      logger.info('Processing voice conversation', {
        correlationId: req.correlationId,
        userId,
        filename: req.file.originalname,
        fileSize: req.file.buffer.length,
        conversationId: conversation_id,
        options: {
          inputLanguage: options.inputLanguage,
          outputVoice: options.outputVoice,
          outputFormat: options.outputFormat
        }
      });

      // Define chat processor function
      const chatProcessor = async (transcribedText, chatOptions) => {
        return await vortexService.processChat({
          userId,
          message: transcribedText,
          ...chatOptions
        });
      };

      // Process the complete voice conversation
      const result = await voiceService.processVoiceConversation(
        req.file.buffer,
        req.file.originalname,
        chatProcessor,
        options
      );

      // Return JSON response with audio data as base64
      const responseData = {
        transcription: {
          text: result.transcription.text,
          language: result.transcription.language,
          confidence: result.transcription.confidence
        },
        response: result.chatResponse.response,
        conversation_id: result.chatResponse.conversation_id,
        audio: {
          data: result.synthesis.audioBuffer.toString('base64'),
          contentType: result.synthesis.contentType,
          format: result.synthesis.format,
          voice: result.synthesis.voice
        },
        metadata: {
          ...result.chatResponse.metadata,
          processingTime: result.processingTime,
          voiceProcessing: true
        }
      };

      // Include debug information if requested
      if (options.chatOptions.debug && result.chatResponse.debug) {
        responseData.debug = result.chatResponse.debug;
      }

      logger.info('Voice conversation completed', {
        correlationId: req.correlationId,
        userId,
        conversationId: result.chatResponse.conversation_id,
        transcriptionLength: result.transcription.text.length,
        responseLength: result.chatResponse.response.length,
        audioSize: result.synthesis.audioBuffer.length,
        processingTime: result.processingTime
      });

      res.success(responseData, 'Voice conversation processed successfully');

    } catch (error) {
      logger.error('Voice conversation failed', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Get multer upload middleware for routes
   */
  getUploadMiddleware() {
    return upload.single('audio');
  }
}

module.exports = new VoiceController();