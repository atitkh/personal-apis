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
    const allowedExtensions = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm', '.pcm'];
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
      
      // Add setup instructions if services are not available
      if (status.overall !== 'operational') {
        status.setup_instructions = {
          message: "Voice services are not currently configured or running.",
          steps: [
            "1. Set up Whisper server: Install and run whisper-server on configured host/port",
            "2. Set up Piper server: Install and run piper-tts on configured host/port", 
            "3. Configure environment variables: WHISPER_HOST, WHISPER_PORT, PIPER_HOST, PIPER_PORT",
            "4. Or run with Docker: docker run -p 9000:9000 whisper-server && docker run -p 9001:9001 piper-tts"
          ],
          current_config: {
            whisper_url: status.whisper.url,
            piper_url: status.piper.url
          }
        };
      }
      
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

      // Parse audio format from file or use defaults
      const options = {
        language: req.body.language || 'en',
        sampleRate: req.body.sample_rate ? parseInt(req.body.sample_rate) : 16000,
        channels: req.body.channels ? parseInt(req.body.channels) : 1,
        sampleWidth: req.body.sample_width ? parseInt(req.body.sample_width) : 2
      };

      logger.info('Processing speech-to-text request', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        filename: req.file.originalname,
        fileSize: req.file.buffer.length,
        options
      });

      // Get the audio buffer - use raw PCM directly
      let audioBuffer = req.file.buffer;
      // No need to strip WAV header - frontend sends raw PCM

      const result = await voiceService.speechToText(audioBuffer, options);

      // Check if STT was successful
      if (!result.success) {
        return res.error(result.error || 'Speech-to-text failed', 503);
      }

      res.success({
        text: result.text,
        language: result.language
      }, 'Speech converted to text successfully');

    } catch (error) {
      logger.error('Speech-to-text conversion failed', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      
      // Handle voice service unavailable errors with better responses
      if (error.message.includes('Voice services not configured') || error.message.includes('not available')) {
        return res.error(error.message, 503); // Service Unavailable
      }
      
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
        speaker: req.body.speaker_id ? String(req.body.speaker_id) : undefined
      };

      logger.info('Processing text-to-speech request', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        textLength: text.length,
        options
      });

      const result = await voiceService.textToSpeech(text, options);

      // Check if TTS was successful
      if (!result.success) {
        return res.error(result.error || 'Text-to-speech failed', 503);
      }

      // Validate audio data exists
      if (!result.audio || result.audio.length === 0) {
        return res.error('TTS returned empty audio data', 503);
      }

      // Validate format exists
      if (!result.format) {
        return res.error('TTS returned no format information', 503);
      }

      // Convert raw PCM to WAV
      const wavBuffer = voiceService.rawToWav(
        result.audio,
        result.format.rate || 22050,
        result.format.channels || 1,
        result.format.width || 2
      );

      // Set appropriate headers for audio response
      res.set({
        'Content-Type': 'audio/wav',
        'Content-Length': wavBuffer.length,
        'Content-Disposition': 'inline; filename="speech.wav"'
      });

      res.send(wavBuffer);

    } catch (error) {
      logger.error('Text-to-speech conversion failed', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      
      // Handle voice service unavailable errors with better responses
      if (error.message.includes('Voice services not configured') || error.message.includes('not available')) {
        return res.error(error.message, 503); // Service Unavailable
      }
      
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
        logger.info('Chat processor called with transcribed text', {
          correlationId: req.correlationId,
          transcribedText,
          transcribedTextLength: transcribedText?.length || 0,
          chatOptions: JSON.stringify(chatOptions)
        });
        
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
      
      // Handle voice service unavailable errors with better responses
      if (error.message.includes('Voice services not configured') || error.message.includes('not available')) {
        return res.error(error.message, 503); // Service Unavailable
      }
      
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