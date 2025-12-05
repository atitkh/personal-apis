/**
 * Voice Service - Wyoming Protocol Implementation
 * 
 * Wyoming Protocol Message Format:
 * { "type": "...", "data": { ... }, "data_length": ..., "payload_length": ... }\n
 * <data_length bytes (optional)>\n
 * <payload_length bytes (optional)>
 * 
 * Service Discovery: describe -> info
 * Speech-to-Text: transcribe -> audio-start -> audio-chunk(s) -> audio-stop -> transcript
 * Text-to-Speech: synthesize -> audio-start -> audio-chunk(s) -> audio-stop
 */

const net = require('net');
const { spawn } = require('child_process');
const { logger } = require('../utils/logger');

/**
 * Convert audio buffer from various formats to raw PCM using ffmpeg
 * @param {Buffer} inputBuffer - Input audio buffer (WebM, MP3, WAV, etc.)
 * @param {string} inputFormat - Input format hint (webm, mp3, wav, etc.)
 * @param {Object} options - Output options
 * @returns {Promise<Buffer>} - Raw PCM audio buffer
 */
async function convertToPCM(inputBuffer, inputFormat = 'webm', options = {}) {
    const {
        sampleRate = 16000,
        channels = 1,
        sampleWidth = 2  // 16-bit = 2 bytes
    } = options;

    // If input is already raw PCM with correct parameters, no conversion needed
    if (inputFormat === 'pcm' || inputFormat === 's16le') {
        logger.debug('Input is already PCM, skipping conversion', {
            inputSize: inputBuffer.length,
            sampleRate,
            channels,
            sampleWidth
        });
        return inputBuffer;
    }

    return new Promise((resolve, reject) => {
        const ffmpegArgs = [];
        
        // Add input format parameters for raw PCM input
        if (inputFormat === 'raw' || inputFormat === 'pcm_s16le') {
            ffmpegArgs.push(
                '-f', 's16le',
                '-ar', String(sampleRate),
                '-ac', String(channels)
            );
        }
        
        ffmpegArgs.push(
            '-i', 'pipe:0',           // Read from stdin
            '-f', 's16le',            // Output format: signed 16-bit little-endian PCM
            '-acodec', 'pcm_s16le',   // Audio codec
            '-ar', String(sampleRate), // Sample rate
            '-ac', String(channels),   // Channels
            'pipe:1'                   // Output to stdout
        );

        logger.debug('Converting audio to PCM', {
            inputSize: inputBuffer.length,
            inputFormat,
            sampleRate,
            channels,
            sampleWidth
        });

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const chunks = [];
        let stderrOutput = '';

        ffmpeg.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        ffmpeg.stderr.on('data', (data) => {
            stderrOutput += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const outputBuffer = Buffer.concat(chunks);
                logger.debug('Audio conversion successful', {
                    inputSize: inputBuffer.length,
                    outputSize: outputBuffer.length,
                    duration: outputBuffer.length / (sampleRate * channels * sampleWidth)
                });
                resolve(outputBuffer);
            } else {
                logger.error('FFmpeg conversion failed', {
                    code,
                    stderr: stderrOutput.substring(0, 500)
                });
                reject(new Error(`FFmpeg exited with code ${code}: ${stderrOutput.substring(0, 200)}`));
            }
        });

        ffmpeg.on('error', (err) => {
            logger.error('FFmpeg spawn error', { error: err.message });
            reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
        });

        // Write input buffer to ffmpeg stdin
        ffmpeg.stdin.write(inputBuffer);
        ffmpeg.stdin.end();
    });
}

class WyomingClient {
    constructor(host, port, timeout = 30000) {
        this.host = host;
        this.port = port;
        this.timeout = timeout;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Connect to Wyoming server
     */
    async connect() {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            
            logger.debug('Attempting Wyoming connection', {
                host: this.host,
                port: this.port,
                timeout: this.timeout
            });

            const timeoutId = setTimeout(() => {
                this.socket.destroy();
                reject(new Error(`Connection timeout to ${this.host}:${this.port} after ${this.timeout}ms`));
            }, this.timeout);

            this.socket.connect(this.port, this.host, () => {
                clearTimeout(timeoutId);
                logger.debug('Wyoming connection established', {
                    host: this.host,
                    port: this.port
                });
                resolve();
            });

            this.socket.on('error', (error) => {
                clearTimeout(timeoutId);
                logger.error('Wyoming connection error', {
                    host: this.host,
                    port: this.port,
                    error: error.message,
                    code: error.code
                });
                reject(new Error(`Failed to connect to ${this.host}:${this.port}: ${error.message}`));
            });
        });
    }

    /**
     * Disconnect from Wyoming server
     */
    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Send a Wyoming event (JSON header only, no payload)
     * Wyoming format: {"type": "...", "data": {...}}\n
     */
    sendEvent(type, data = {}) {
        const event = { type, data };
        const message = JSON.stringify(event) + '\n';
        this.socket.write(message);
    }

    /**
     * Send a Wyoming event with binary payload
     * Wyoming format: {"type": "...", "data": {...}, "payload_length": N}\n<N bytes>
     */
    sendEventWithPayload(type, data = {}, payload = Buffer.alloc(0)) {
        const event = { 
            type, 
            data,
            payload_length: payload.length 
        };
        const header = JSON.stringify(event) + '\n';
        this.socket.write(header);
        if (payload.length > 0) {
            this.socket.write(payload);
        }
    }

    /**
     * Read the next Wyoming event from the connection
     * 
     * Wyoming message format:
     * {"type": "...", "data_length": N, "payload_length": M}\n
     * <N bytes of JSON data>
     * <M bytes of binary payload>
     * 
     * OR simple format (used for describe responses):
     * {"type": "info", "data": {...}}\n
     */
    async readEvent() {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.socket.removeAllListeners('data');
                reject(new Error('Read timeout'));
            }, this.timeout);

            let headerParsed = false;
            let header = null;
            let dataLength = 0;
            let payloadLength = 0;
            let dataBuffer = Buffer.alloc(0);
            let payloadBuffer = Buffer.alloc(0);

            const processBuffer = () => {
                // Step 1: Parse JSON header (ends with newline)
                if (!headerParsed) {
                    const newlineIndex = this.buffer.indexOf(0x0a); // \n
                    if (newlineIndex === -1) return false; // Need more data

                    try {
                        const headerStr = this.buffer.slice(0, newlineIndex).toString('utf8');
                        header = JSON.parse(headerStr);
                        headerParsed = true;
                        dataLength = header.data_length || 0;
                        payloadLength = header.payload_length || 0;
                        this.buffer = this.buffer.slice(newlineIndex + 1);
                    } catch (e) {
                        clearTimeout(timeoutId);
                        this.socket.removeListener('data', onData);
                        reject(new Error(`Invalid JSON header: ${e.message}`));
                        return true;
                    }
                }

                // Step 2: Read data bytes if present (this is JSON)
                if (dataLength > 0 && dataBuffer.length < dataLength) {
                    const needed = dataLength - dataBuffer.length;
                    const available = Math.min(needed, this.buffer.length);
                    dataBuffer = Buffer.concat([dataBuffer, this.buffer.slice(0, available)]);
                    this.buffer = this.buffer.slice(available);
                    
                    if (dataBuffer.length < dataLength) return false; // Need more data
                }

                // Step 3: Read payload bytes if present (this is binary)
                if (payloadLength > 0 && payloadBuffer.length < payloadLength) {
                    const needed = payloadLength - payloadBuffer.length;
                    const available = Math.min(needed, this.buffer.length);
                    payloadBuffer = Buffer.concat([payloadBuffer, this.buffer.slice(0, available)]);
                    this.buffer = this.buffer.slice(available);
                    
                    if (payloadBuffer.length < payloadLength) return false; // Need more data
                }

                // All data received
                clearTimeout(timeoutId);
                this.socket.removeListener('data', onData);
                
                // Parse data if present
                let parsedData = header.data || {};
                if (dataLength > 0) {
                    try {
                        parsedData = JSON.parse(dataBuffer.toString('utf8'));
                    } catch (e) {
                        // Keep as-is if not valid JSON
                        logger.warn('Failed to parse data as JSON', { error: e.message });
                    }
                }

                resolve({
                    type: header.type,
                    data: parsedData,
                    payload: payloadBuffer
                });
                return true;
            };

            const onData = (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                processBuffer();
            };

            this.socket.on('data', onData);

            // Try to process any existing buffer data first
            if (this.buffer.length > 0) {
                if (processBuffer()) return;
            }
        });
    }

    /**
     * Read events until a specific type is received
     */
    async readUntil(stopType) {
        const events = [];
        while (true) {
            const event = await this.readEvent();
            events.push(event);
            if (event.type === stopType) {
                break;
            }
        }
        return events;
    }
}

class VoiceService {
    constructor() {
        // Parse Whisper URL (STT)
        const whisperUrl = process.env.WHISPER_BASE_URL || 'http://localhost:10300';
        const whisperParsed = this.parseUrl(whisperUrl);
        this.whisperHost = whisperParsed.host;
        this.whisperPort = whisperParsed.port;

        // Parse Piper URL (TTS)
        const piperUrl = process.env.PIPER_BASE_URL || 'http://localhost:10200';
        const piperParsed = this.parseUrl(piperUrl);
        this.piperHost = piperParsed.host;
        this.piperPort = piperParsed.port;

        // Default TTS voice
        this.defaultVoice = process.env.PIPER_VOICE || 'en_US-amy-medium';

        // Connection timeout
        this.timeout = parseInt(process.env.VOICE_TIMEOUT) || 30000;

        logger.info('VoiceService initialized with Wyoming Protocol', {
            whisper: `${this.whisperHost}:${this.whisperPort}`,
            piper: `${this.piperHost}:${this.piperPort}`,
            defaultVoice: this.defaultVoice
        });
    }

    /**
     * Parse URL to extract host and port
     */
    parseUrl(url) {
        try {
            if (!url.includes('://')) {
                url = `http://${url}`;
            }
            const parsed = new URL(url);
            return {
                host: parsed.hostname,
                port: parseInt(parsed.port) || 80
            };
        } catch (error) {
            logger.error('Failed to parse URL', { url, error: error.message });
            return { host: 'localhost', port: 80 };
        }
    }

    /**
     * Get service info using describe -> info flow
     */
    async getServiceInfo(host, port, serviceName) {
        const client = new WyomingClient(host, port, this.timeout);
        
        try {
            await client.connect();
            
            // Send describe request
            client.sendEvent('describe');
            
            // Read info response
            const event = await client.readEvent();
            
            if (event.type !== 'info') {
                throw new Error(`Expected 'info' response, got '${event.type}'`);
            }

            logger.debug(`${serviceName} service info retrieved`, {
                asrCount: event.data.asr?.length || 0,
                ttsCount: event.data.tts?.length || 0
            });

            return {
                success: true,
                info: event.data
            };
        } catch (error) {
            logger.error(`${serviceName} service info failed`, { error: error.message });
            return {
                success: false,
                error: error.message
            };
        } finally {
            client.disconnect();
        }
    }

    /**
     * Check health of a Wyoming service
     */
    async checkHealth(host, port, serviceName) {
        const result = await this.getServiceInfo(host, port, serviceName);
        
        if (result.success) {
            return {
                healthy: true,
                services: {
                    asr: result.info.asr || [],
                    tts: result.info.tts || []
                }
            };
        }
        
        return {
            healthy: false,
            error: result.error
        };
    }

    /**
     * Check health of both voice services
     */
    async checkAllHealth() {
        const [whisperHealth, piperHealth] = await Promise.all([
            this.checkHealth(this.whisperHost, this.whisperPort, 'Whisper'),
            this.checkHealth(this.piperHost, this.piperPort, 'Piper')
        ]);

        return {
            whisper: whisperHealth,
            piper: piperHealth,
            overall: whisperHealth.healthy && piperHealth.healthy
        };
    }

    /**
     * Speech-to-Text using Wyoming Protocol
     * 
     * Flow:
     * 1. transcribe (with optional language/model)
     * 2. audio-start
     * 3. audio-chunk (one or more)
     * 4. audio-stop
     * 5. <- transcript
     */
    async speechToText(audioBuffer, options = {}) {
        const {
            language = 'en',
            sampleRate = 16000,
            channels = 1,
            sampleWidth = 2,
            inputFormat = 'webm'  // Default to webm since browser records in this format
        } = options;

        logger.info('Starting speech-to-text', {
            audioSize: audioBuffer.length,
            language,
            sampleRate,
            inputFormat
        });

        // Convert audio to raw PCM format for Wyoming/Whisper
        let pcmBuffer;
        try {
            pcmBuffer = await convertToPCM(audioBuffer, inputFormat, {
                sampleRate,
                channels,
                sampleWidth
            });
            
            logger.info('Audio converted to PCM', {
                originalSize: audioBuffer.length,
                pcmSize: pcmBuffer.length,
                estimatedDuration: pcmBuffer.length / (sampleRate * channels * sampleWidth)
            });
        } catch (conversionError) {
            logger.error('Audio conversion failed', { error: conversionError.message });
            return {
                success: false,
                error: `Audio conversion failed: ${conversionError.message}`
            };
        }

        const client = new WyomingClient(this.whisperHost, this.whisperPort, this.timeout);

        try {
            await client.connect();

            // 1. Send transcribe request
            client.sendEvent('transcribe', { language });

            // 2. Send audio-start
            client.sendEvent('audio-start', {
                rate: sampleRate,
                width: sampleWidth,
                channels: channels
            });

            // 3. Send PCM audio data in chunks
            const chunkSize = 8192;
            for (let offset = 0; offset < pcmBuffer.length; offset += chunkSize) {
                const chunk = pcmBuffer.slice(offset, Math.min(offset + chunkSize, pcmBuffer.length));
                
                client.sendEventWithPayload('audio-chunk', {
                    rate: sampleRate,
                    width: sampleWidth,
                    channels: channels
                }, chunk);
            }

            // 4. Send audio-stop
            client.sendEvent('audio-stop');

            // 5. Wait for transcript response
            const event = await client.readEvent();
            
            if (event.type !== 'transcript') {
                throw new Error(`Expected 'transcript' response, got '${event.type}'`);
            }

            const text = event.data.text || '';
            
            logger.info('Speech-to-text completed', { 
                textLength: text.length,
                text: text.substring(0, 100) 
            });

            return {
                success: true,
                text,
                language: event.data.language || language
            };

        } catch (error) {
            logger.error('Speech-to-text failed', { error: error.message });
            return {
                success: false,
                error: error.message
            };
        } finally {
            client.disconnect();
        }
    }

    /**
     * Text-to-Speech using Wyoming Protocol
     * 
     * Flow:
     * 1. synthesize (with text and voice)
     * 2. <- audio-start
     * 3. <- audio-chunk (one or more)
     * 4. <- audio-stop
     */
    async textToSpeech(text, options = {}) {
        const {
            voice = this.defaultVoice,
            speaker = null
        } = options;

        logger.info('Starting text-to-speech', {
            textLength: text.length,
            voice,
            text: text.substring(0, 100)
        });

        const client = new WyomingClient(this.piperHost, this.piperPort, this.timeout);

        try {
            await client.connect();

            // 1. Send synthesize request
            const voiceData = { name: voice };
            if (speaker) {
                voiceData.speaker = speaker;
            }
            
            client.sendEvent('synthesize', {
                text,
                voice: voiceData
            });

            // 2-4. Read audio events until audio-stop
            const events = await client.readUntil('audio-stop');
            
            // Extract audio format from audio-start
            const audioStart = events.find(e => e.type === 'audio-start');
            const format = audioStart ? audioStart.data : {
                rate: 22050,
                width: 2,
                channels: 1
            };

            // Combine audio chunks
            const audioChunks = events
                .filter(e => e.type === 'audio-chunk')
                .map(e => e.payload);
            
            logger.debug('TTS received chunks', {
                chunkCount: audioChunks.length,
                chunkSizes: audioChunks.map(c => c ? c.length : 0)
            });

            if (audioChunks.length === 0) {
                throw new Error('No audio chunks received from TTS service');
            }

            const audioBuffer = Buffer.concat(audioChunks);

            if (audioBuffer.length === 0) {
                throw new Error('TTS returned empty audio buffer');
            }

            logger.info('Text-to-speech completed', {
                audioSize: audioBuffer.length,
                format
            });

            return {
                success: true,
                audio: audioBuffer,
                format,
                contentType: 'audio/raw'
            };

        } catch (error) {
            logger.error('Text-to-speech failed', { error: error.message });
            return {
                success: false,
                error: error.message
            };
        } finally {
            client.disconnect();
        }
    }

    /**
     * Get available voices from Piper
     */
    async getVoices() {
        const result = await this.getServiceInfo(this.piperHost, this.piperPort, 'Piper');
        
        if (result.success) {
            const voices = result.info.tts || [];
            return {
                success: true,
                voices: voices.map(v => ({
                    name: v.name,
                    description: v.description,
                    languages: v.languages || [],
                    speakers: v.speakers || []
                }))
            };
        }
        
        return {
            success: false,
            error: result.error,
            voices: []
        };
    }

    /**
     * Get available ASR models from Whisper
     */
    async getModels() {
        const result = await this.getServiceInfo(this.whisperHost, this.whisperPort, 'Whisper');
        
        if (result.success) {
            const models = result.info.asr || [];
            return {
                success: true,
                models: models.map(m => ({
                    name: m.name,
                    description: m.description,
                    languages: m.languages || []
                }))
            };
        }
        
        return {
            success: false,
            error: result.error,
            models: []
        };
    }

    /**
     * Convert raw PCM audio to WAV format
     */
    rawToWav(rawBuffer, sampleRate = 22050, channels = 1, sampleWidth = 2) {
        const dataLength = rawBuffer.length;
        const wavHeader = Buffer.alloc(44);
        
        // RIFF header
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(36 + dataLength, 4);
        wavHeader.write('WAVE', 8);
        
        // fmt chunk
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16);
        wavHeader.writeUInt16LE(1, 20); // PCM format
        wavHeader.writeUInt16LE(channels, 22);
        wavHeader.writeUInt32LE(sampleRate, 24);
        wavHeader.writeUInt32LE(sampleRate * channels * sampleWidth, 28);
        wavHeader.writeUInt16LE(channels * sampleWidth, 32);
        wavHeader.writeUInt16LE(sampleWidth * 8, 34);
        
        // data chunk
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(dataLength, 40);
        
        return Buffer.concat([wavHeader, rawBuffer]);
    }

    /**
     * Get service status (for controller compatibility)
     */
    async getStatus() {
        const health = await this.checkAllHealth();
        
        return {
            whisper: {
                url: `${this.whisperHost}:${this.whisperPort}`,
                status: health.whisper.healthy ? 'operational' : 'unavailable',
                error: health.whisper.error
            },
            piper: {
                url: `${this.piperHost}:${this.piperPort}`,
                status: health.piper.healthy ? 'operational' : 'unavailable',
                error: health.piper.error
            },
            overall: health.overall ? 'operational' : 'degraded'
        };
    }

    /**
     * Get available voices (for controller compatibility)
     */
    async getAvailableVoices() {
        const result = await this.getVoices();
        return result.voices || [];
    }

    /**
     * Process a complete voice conversation
     */
    async processVoiceConversation(audioBuffer, filename, chatProcessor, options = {}) {
        const startTime = Date.now();

        logger.info('Processing voice conversation', {
            audioBufferLength: audioBuffer.length,
            filename,
            inputLanguage: options.inputLanguage,
            outputVoice: options.outputVoice
        });

        // Step 1: Speech to Text
        // Detect input format from filename
        const inputFormat = filename ? filename.toLowerCase().split('.').pop() : 'webm';
        
        const sttResult = await this.speechToText(audioBuffer, {
            language: options.inputLanguage,
            sampleRate: 16000,
            channels: 1,
            sampleWidth: 2,
            inputFormat
        });

        if (!sttResult.success) {
            throw new Error(`Speech-to-text failed: ${sttResult.error}`);
        }

        // Log the transcription result for debugging
        logger.info('Voice transcription result', {
            success: sttResult.success,
            textLength: sttResult.text?.length || 0,
            text: sttResult.text,
            language: sttResult.language
        });

        // Step 2: Process with chat
        const chatResponse = await chatProcessor(sttResult.text, options.chatOptions);

        // Step 3: Text to Speech
        const ttsResult = await this.textToSpeech(chatResponse.response, {
            voice: options.outputVoice || this.defaultVoice
        });

        if (!ttsResult.success) {
            throw new Error(`Text-to-speech failed: ${ttsResult.error}`);
        }

        // Convert to WAV
        const wavBuffer = this.rawToWav(
            ttsResult.audio,
            ttsResult.format.rate,
            ttsResult.format.channels,
            ttsResult.format.width
        );

        return {
            transcription: {
                text: sttResult.text,
                language: sttResult.language,
                confidence: 1.0
            },
            chatResponse,
            synthesis: {
                audioBuffer: wavBuffer,
                contentType: 'audio/wav',
                format: 'wav',
                voice: options.outputVoice || this.defaultVoice
            },
            processingTime: Date.now() - startTime
        };
    }
}

// Export singleton instance
module.exports = new VoiceService();
