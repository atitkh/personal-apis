const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('../utils/logger');

class VoiceService {
  constructor() {
    // Whisper configuration
    this.whisperHost = process.env.WHISPER_HOST || 'localhost';
    this.whisperPort = process.env.WHISPER_PORT || '9000';
    this.whisperBaseUrl = `http://${this.whisperHost}:${this.whisperPort}`;
    
    // Piper configuration
    this.piperHost = process.env.PIPER_HOST || 'localhost';
    this.piperPort = process.env.PIPER_PORT || '9001';
    this.piperBaseUrl = `http://${this.piperHost}:${this.piperPort}`;
    
    // Voice settings
    this.defaultVoice = process.env.PIPER_DEFAULT_VOICE || 'en_US-lessac-medium';
    this.whisperModel = process.env.WHISPER_MODEL || 'base';
    this.whisperLanguage = process.env.WHISPER_LANGUAGE || 'auto';
    
    // Supported audio formats
    this.supportedAudioFormats = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'webm'];
  }

  /**
   * Safe logging that falls back to console if logger is not available
   */
  safeLog(level, message, meta = {}) {
    if (logger && typeof logger[level] === 'function') {
      logger[level](message, meta);
    } else {
      console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}`, meta);
    }
  }

  /**
   * Check if Whisper service is available
   */
  async checkWhisperHealth() {
    try {
      const response = await axios.get(`${this.whisperBaseUrl}/health`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      this.safeLog('debug', 'Whisper health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Check if Piper service is available
   */
  async checkPiperHealth() {
    try {
      const response = await axios.get(`${this.piperBaseUrl}/health`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      this.safeLog('debug', 'Piper health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Convert speech to text using Whisper
   * @param {Buffer} audioBuffer - Audio file buffer
   * @param {string} filename - Original filename (used to determine format)
   * @param {Object} options - Transcription options
   */
  async speechToText(audioBuffer, filename, options = {}) {
    try {
      // Validate audio format
      const fileExtension = filename.split('.').pop().toLowerCase();
      if (!this.supportedAudioFormats.includes(fileExtension)) {
        throw new Error(`Unsupported audio format: ${fileExtension}. Supported formats: ${this.supportedAudioFormats.join(', ')}`);
      }

      // Check if Whisper is available
      const isHealthy = await this.checkWhisperHealth();
      if (!isHealthy) {
        throw new Error(`Whisper service not available at ${this.whisperBaseUrl}`);
      }

      // Prepare form data
      const formData = new FormData();
      formData.append('audio', audioBuffer, {
        filename: filename,
        contentType: this.getContentType(fileExtension)
      });
      
      // Add optional parameters
      if (options.language || this.whisperLanguage !== 'auto') {
        formData.append('language', options.language || this.whisperLanguage);
      }
      
      if (options.model || this.whisperModel !== 'base') {
        formData.append('model', options.model || this.whisperModel);
      }

      if (options.temperature !== undefined) {
        formData.append('temperature', options.temperature.toString());
      }

      if (options.response_format) {
        formData.append('response_format', options.response_format);
      }

      this.safeLog('info', 'Sending audio to Whisper for transcription', {
        audioSize: audioBuffer.length,
        filename,
        language: options.language || this.whisperLanguage,
        model: options.model || this.whisperModel
      });

      // Send request to Whisper
      const response = await axios.post(`${this.whisperBaseUrl}/v1/audio/transcriptions`, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 30000, // 30 second timeout for transcription
        maxContentLength: 25 * 1024 * 1024, // 25MB max file size
      });

      const transcription = response.data;
      
      this.safeLog('info', 'Whisper transcription completed', {
        transcriptionLength: transcription.text?.length || 0,
        language: transcription.language || 'unknown'
      });

      return {
        text: transcription.text,
        language: transcription.language,
        duration: transcription.duration,
        confidence: transcription.confidence || null,
        segments: transcription.segments || null
      };

    } catch (error) {
      this.safeLog('error', 'Speech-to-text conversion failed', {
        error: error.message,
        whisperUrl: this.whisperBaseUrl
      });
      throw new Error(`Speech-to-text failed: ${error.message}`);
    }
  }

  /**
   * Convert text to speech using Piper
   * @param {string} text - Text to synthesize
   * @param {Object} options - TTS options
   */
  async textToSpeech(text, options = {}) {
    try {
      if (!text || typeof text !== 'string') {
        throw new Error('Text is required for text-to-speech conversion');
      }

      // Check if Piper is available
      const isHealthy = await this.checkPiperHealth();
      if (!isHealthy) {
        throw new Error(`Piper service not available at ${this.piperBaseUrl}`);
      }

      const requestData = {
        text: text.trim(),
        voice: options.voice || this.defaultVoice,
        speed: options.speed || 1.0,
        output_format: options.output_format || 'wav'
      };

      // Add optional parameters
      if (options.speaker_id !== undefined) {
        requestData.speaker_id = options.speaker_id;
      }

      if (options.noise_scale !== undefined) {
        requestData.noise_scale = options.noise_scale;
      }

      if (options.length_scale !== undefined) {
        requestData.length_scale = options.length_scale;
      }

      this.safeLog('info', 'Sending text to Piper for synthesis', {
        textLength: text.length,
        voice: requestData.voice,
        speed: requestData.speed,
        format: requestData.output_format
      });

      // Send request to Piper
      const response = await axios.post(`${this.piperBaseUrl}/v1/tts`, requestData, {
        headers: {
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer', // Important: Get binary audio data
        timeout: 30000, // 30 second timeout
      });

      this.safeLog('info', 'Piper synthesis completed', {
        audioSize: response.data.length,
        contentType: response.headers['content-type']
      });

      return {
        audioBuffer: Buffer.from(response.data),
        contentType: response.headers['content-type'] || 'audio/wav',
        format: requestData.output_format,
        voice: requestData.voice
      };

    } catch (error) {
      this.safeLog('error', 'Text-to-speech conversion failed', {
        error: error.message,
        piperUrl: this.piperBaseUrl,
        textLength: text?.length || 0
      });
      throw new Error(`Text-to-speech failed: ${error.message}`);
    }
  }

  /**
   * Get available voices from Piper
   */
  async getAvailableVoices() {
    try {
      const response = await axios.get(`${this.piperBaseUrl}/v1/voices`, {
        timeout: 10000
      });
      
      return response.data.voices || [];
    } catch (error) {
      this.safeLog('error', 'Failed to get available voices', {
        error: error.message,
        piperUrl: this.piperBaseUrl
      });
      return [];
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    const whisperHealth = await this.checkWhisperHealth();
    const piperHealth = await this.checkPiperHealth();
    
    let availableVoices = [];
    if (piperHealth) {
      try {
        availableVoices = await this.getAvailableVoices();
      } catch (error) {
        // Ignore error, just use empty array
      }
    }

    return {
      whisper: {
        status: whisperHealth ? 'available' : 'unavailable',
        url: this.whisperBaseUrl,
        model: this.whisperModel,
        language: this.whisperLanguage,
        supportedFormats: this.supportedAudioFormats
      },
      piper: {
        status: piperHealth ? 'available' : 'unavailable',
        url: this.piperBaseUrl,
        defaultVoice: this.defaultVoice,
        availableVoices: availableVoices.length > 0 ? availableVoices : ['Status check required']
      },
      overall: whisperHealth && piperHealth ? 'operational' : 'partial'
    };
  }

  /**
   * Get content type for audio file extension
   */
  getContentType(extension) {
    const contentTypes = {
      'wav': 'audio/wav',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'flac': 'audio/flac',
      'm4a': 'audio/mp4',
      'webm': 'audio/webm'
    };
    
    return contentTypes[extension.toLowerCase()] || 'audio/wav';
  }

  /**
   * Process voice conversation: speech -> text -> AI response -> speech
   * @param {Buffer} audioBuffer - Input audio
   * @param {string} filename - Audio filename
   * @param {Function} chatProcessor - Function to process the transcribed text
   * @param {Object} options - Processing options
   */
  async processVoiceConversation(audioBuffer, filename, chatProcessor, options = {}) {
    try {
      // Step 1: Convert speech to text
      this.safeLog('info', 'Starting voice conversation processing');
      
      const transcription = await this.speechToText(audioBuffer, filename, {
        language: options.inputLanguage,
        model: options.whisperModel
      });

      if (!transcription.text || transcription.text.trim().length === 0) {
        throw new Error('No speech detected in audio');
      }

      this.safeLog('info', 'Transcription completed', {
        text: transcription.text,
        language: transcription.language
      });

      // Step 2: Process with AI
      const chatResponse = await chatProcessor(transcription.text, {
        ...options.chatOptions,
        voiceInput: true,
        detectedLanguage: transcription.language
      });

      // Step 3: Convert AI response to speech
      const synthesis = await this.textToSpeech(chatResponse.response, {
        voice: options.outputVoice,
        speed: options.speechSpeed,
        output_format: options.outputFormat
      });

      return {
        transcription,
        chatResponse,
        synthesis,
        processingTime: Date.now() - (options.startTime || Date.now())
      };

    } catch (error) {
      this.safeLog('error', 'Voice conversation processing failed', {
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new VoiceService();