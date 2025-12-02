class VortexDebugInterface {
    constructor() {
        console.log('VortexDebugInterface initialized');
        this.token = localStorage.getItem('vortex_token');
        this.user = null;
        this.conversationId = 'debug-' + Date.now();
        
        console.log('Token from localStorage:', this.token ? 'exists' : 'not found');
        
        this.initializeElements();
        this.bindEvents();
        this.checkAuth();
    }

    initializeElements() {
        // Login elements
        this.loginContainer = document.getElementById('loginContainer');
        this.loginForm = document.getElementById('loginForm');
        this.loginError = document.getElementById('loginError');
        
        // Chat elements
        this.chatContainer = document.getElementById('chatContainer');
        this.chatMessages = document.getElementById('chatMessages');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.userEmail = document.getElementById('userEmail');
        this.logoutBtn = document.getElementById('logoutBtn');
        
        // Debug elements
        this.conversationIdInput = document.getElementById('conversationId');
        this.debugOutput = document.getElementById('debugOutput');
        this.debugBtn = document.getElementById('debugBtn');
        this.newConversationBtn = document.getElementById('newConversationBtn');
        this.clearChatBtn = document.getElementById('clearChatBtn');
        this.debugTokenBtn = document.getElementById('debugTokenBtn');
        this.testMessageBtn = document.getElementById('testMessageBtn');
        
        // Memory exploration elements
        this.memoryType = document.getElementById('memoryType');
        this.memorySearch = document.getElementById('memorySearch');
        this.browseMemoriesBtn = document.getElementById('browseMemoriesBtn');
        this.searchMemoriesBtn = document.getElementById('searchMemoriesBtn');
        
        // Voice interface elements
        this.recordBtn = document.getElementById('recordBtn');
        this.playLastBtn = document.getElementById('playLastBtn');
        this.voiceStatus = document.getElementById('voiceStatus');
        this.voiceEnabled = document.getElementById('voiceEnabled');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.speechSpeed = document.getElementById('speechSpeed');
        this.speedValue = document.getElementById('speedValue');
        this.testVoiceBtn = document.getElementById('testVoiceBtn');
        this.voiceStatusBtn = document.getElementById('voiceStatusBtn');
        
        // Voice-related properties
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.lastAudioResponse = null;
        this.currentAudio = null;
        
        // Set initial conversation ID
        this.conversationIdInput.value = this.conversationId;
    }

    bindEvents() {
        // Login events
        this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        
        // Chat events
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        this.logoutBtn.addEventListener('click', () => this.logout());
        
        // Debug events
        this.debugBtn.addEventListener('click', () => this.debugConversation());
        this.newConversationBtn.addEventListener('click', () => this.newConversation());
        this.clearChatBtn.addEventListener('click', () => this.clearChat());
        this.debugTokenBtn.addEventListener('click', () => this.debugToken());
        this.testMessageBtn.addEventListener('click', () => this.testMessageDisplay());
        
        // Memory exploration events
        this.browseMemoriesBtn.addEventListener('click', () => this.browseMemories());
        this.searchMemoriesBtn.addEventListener('click', () => this.searchMemories());
        this.memorySearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchMemories();
        });
        this.conversationIdInput.addEventListener('change', (e) => {
            this.conversationId = e.target.value;
        });
        
        // Voice events
        this.recordBtn.addEventListener('mousedown', () => this.startRecording());
        this.recordBtn.addEventListener('mouseup', () => this.stopRecording());
        this.recordBtn.addEventListener('mouseleave', () => this.stopRecording());
        this.playLastBtn.addEventListener('click', () => this.playLastResponse());
        this.testVoiceBtn.addEventListener('click', () => this.testVoice());
        this.voiceStatusBtn.addEventListener('click', () => this.checkVoiceStatus());
        this.speechSpeed.addEventListener('input', (e) => {
            this.speedValue.textContent = e.target.value + 'x';
        });
        this.voiceEnabled.addEventListener('change', () => this.toggleVoiceMode());
    }

    async checkAuth() {
        if (!this.token) {
            this.showLogin();
            return;
        }

        try {
            const response = await fetch('/api/v1/auth/profile', {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                console.log('Profile response:', data);
                
                // Handle both direct and wrapped response formats
                this.user = data.data || data;
                this.showChat();
            } else {
                console.log('Profile check failed, showing login');
                localStorage.removeItem('vortex_token');
                this.token = null;
                this.showLogin();
            }
        } catch (error) {
            console.error('Auth check failed:', error);
            this.showLogin();
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        
        try {
            const response = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();
            console.log('Login response:', data);

            if (response.ok) {
                // Handle both direct and wrapped response formats
                this.token = data.data?.token || data.token;
                this.user = data.data?.user || data.user;
                
                if (this.token && this.user) {
                    localStorage.setItem('vortex_token', this.token);
                    this.showChat();
                } else {
                    console.error('Missing token or user in response:', data);
                    this.loginError.textContent = 'Login response format error';
                }
            } else {
                this.loginError.textContent = data.message || 'Login failed';
            }
        } catch (error) {
            console.error('Login error:', error);
            this.loginError.textContent = 'Network error. Please try again.';
        }
    }

    logout() {
        this.token = null;
        this.user = null;
        localStorage.removeItem('vortex_token');
        this.showLogin();
    }

    showLogin() {
        this.loginContainer.style.display = 'flex';
        this.chatContainer.style.display = 'none';
        this.loginError.textContent = '';
    }

    showChat() {
        console.log('Showing chat interface', this.user);
        this.loginContainer.style.display = 'none';
        this.chatContainer.style.display = 'block';
        this.userEmail.textContent = this.user.email || this.user.name || 'User';
        this.messageInput.disabled = false;
        this.sendBtn.disabled = false;
        
        console.log('Chat input enabled:', !this.messageInput.disabled);
        
        // Add welcome message
        this.addMessage('system', `Welcome ${this.user.name || 'User'}! You can now chat with Vortex AI.`);
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;

        // Add user message
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.messageInput.disabled = true;
        this.sendBtn.disabled = true;

        try {
            const response = await fetch('/api/v1/vortex/chat', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: message,
                    conversation_id: this.conversationId,
                    context: { source: 'web_debug' }
                })
            });

            const data = await response.json();
            console.log('Chat API response:', response.status, data);

            if (response.ok) {
                // Handle both direct and wrapped response formats
                const aiResponse = data.data?.response || data.response;
                const debugInfo = data.data?.debug || data.debug;
                
                if (aiResponse) {
                    this.addMessage('assistant', aiResponse);
                } else {
                    console.error('No response field found in API response:', data);
                    this.addMessage('system', '❌ No response received from AI');
                }
                
                // Update debug info if available
                if (debugInfo) {
                    this.updateDebugOutput(debugInfo);
                }
            } else {
                this.addMessage('system', `❌ Error (${response.status}): ${data.message || 'Failed to get response'}`);
            }
        } catch (error) {
            console.error('Send message error:', error);
            this.addMessage('system', '❌ Network error. Please try again.');
        } finally {
            this.messageInput.disabled = false;
            this.sendBtn.disabled = false;
            this.messageInput.focus();
        }
    }

    addMessage(role, content, isVoice = false) {
        console.log('Adding message:', role, content, 'isVoice:', isVoice);
        
        if (!this.chatMessages) {
            console.error('chatMessages element not found!');
            return;
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        const timestamp = new Date().toLocaleTimeString();
        const voiceIcon = isVoice ? ' 🎤' : '';
        
        messageDiv.innerHTML = `
            <div class="message-header">
                <span class="role">${role.charAt(0).toUpperCase() + role.slice(1)}${voiceIcon}</span>
                <span class="timestamp">${timestamp}</span>
            </div>
            <div class="message-content">${this.escapeHtml(content)}</div>
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        
        console.log('Message added, total messages now:', this.chatMessages.children.length);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async debugConversation() {
        if (!this.conversationId) {
            this.debugOutput.textContent = 'Please enter a conversation ID';
            return;
        }

        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        console.log('Debug request with token:', this.token ? 'present' : 'missing');
        console.log('Conversation ID:', this.conversationId);

        try {
            const response = await fetch(`/api/v1/vortex/debug/conversation/${this.conversationId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('Debug response status:', response.status);
            const data = await response.json();
            console.log('Debug response data:', data);

            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Debug failed'}`;
                if (response.status === 401) {
                    this.debugOutput.textContent += '\n\nAuthentication failed. Please logout and login again.';
                }
            }
        } catch (error) {
            console.error('Debug error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    newConversation() {
        this.conversationId = 'debug-' + Date.now();
        this.conversationIdInput.value = this.conversationId;
        this.addMessage('system', `🔄 Started new conversation: ${this.conversationId}`);
    }

    clearChat() {
        this.chatMessages.innerHTML = '';
        this.addMessage('system', '🧹 Chat cleared');
    }

    updateDebugOutput(debugData) {
        const formattedDebug = {
            timestamp: new Date().toISOString(),
            conversation_id: this.conversationId,
            debug_info: debugData
        };
        this.debugOutput.textContent = JSON.stringify(formattedDebug, null, 2);
    }

    debugToken() {
        const tokenInfo = {
            token_exists: !!this.token,
            token_length: this.token ? this.token.length : 0,
            token_preview: this.token ? this.token.substring(0, 20) + '...' : 'null',
            user_info: this.user,
            localStorage_token: localStorage.getItem('vortex_token') ? 'exists' : 'not found'
        };
        this.debugOutput.textContent = JSON.stringify(tokenInfo, null, 2);
        console.log('Token debug info:', tokenInfo);
    }

    testMessageDisplay() {
        console.log('Testing message display...');
        this.addMessage('user', 'Test user message');
        this.addMessage('assistant', 'Test AI response');
        this.addMessage('system', 'Test system message');
        console.log('Test messages added');
    }

    async browseMemories() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        const memoryType = this.memoryType.value;
        console.log('Browsing memories of type:', memoryType);

        try {
            const response = await fetch(`/api/v1/vortex/memory/browse?type=${memoryType}&limit=20`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            console.log('Browse memories response:', data);
            console.log('Response structure:', {
                hasData: !!data.data,
                hasMemories: !!data.memories,
                dataType: typeof data.data,
                memoriesType: typeof data.memories,
                dataIsArray: Array.isArray(data.data),
                memoriesIsArray: Array.isArray(data.memories)
            });

            if (response.ok) {
                // Extract memories array from nested response structure
                let memories = data.data?.memories || data.memories || data.data || data;
                
                // Ensure memories is an array
                if (!Array.isArray(memories)) {
                    console.warn('Memories is not an array:', memories);
                    memories = [];
                }
                
                this.displayMemories(memories, `Recent ${memoryType}`);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to browse memories'}`;
            }
        } catch (error) {
            console.error('Browse memories error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    async searchMemories() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        const query = this.memorySearch.value.trim();
        const memoryType = this.memoryType.value;
        
        if (!query) {
            this.debugOutput.textContent = 'Please enter a search query';
            return;
        }

        console.log('Searching memories:', { query, type: memoryType });

        try {
            const response = await fetch('/api/v1/vortex/memory/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query,
                    type: memoryType,
                    limit: 20
                })
            });

            const data = await response.json();
            console.log('Search memories response:', data);
            console.log('Search response structure:', {
                hasData: !!data.data,
                hasMemories: !!data.memories,
                dataType: typeof data.data,
                memoriesType: typeof data.memories,
                dataIsArray: Array.isArray(data.data),
                memoriesIsArray: Array.isArray(data.memories)
            });

            if (response.ok) {
                // Extract memories array from nested response structure
                let memories = data.data?.memories || data.memories || data.data || data;
                
                // Ensure memories is an array
                if (!Array.isArray(memories)) {
                    console.warn('Memories is not an array:', memories);
                    memories = [];
                }
                
                this.displayMemories(memories, `Search results for "${query}" in ${memoryType}`);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to search memories'}`;
            }
        } catch (error) {
            console.error('Search memories error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    displayMemories(memories, title) {
        console.log('displayMemories called with:', { memories, title, memoriesType: typeof memories, isArray: Array.isArray(memories) });
        
        // Ensure memories is an array
        if (!Array.isArray(memories)) {
            console.error('Memories is not an array:', memories);
            this.debugOutput.textContent = `${title}:\n\nError: Invalid memory data format\nReceived: ${typeof memories}\nData: ${JSON.stringify(memories, null, 2)}`;
            return;
        }
        
        if (memories.length === 0) {
            this.debugOutput.textContent = `${title}:\n\nNo memories found.`;
            return;
        }

        const displayData = {
            title,
            count: memories.length,
            timestamp: new Date().toISOString(),
            memories: memories.map(memory => {
                // Handle different memory formats
                if (memory && typeof memory === 'object') {
                    return {
                        id: memory.id,
                        content: memory.document || memory.content,
                        metadata: memory.metadata || {},
                        distance: memory.distance,
                        relevanceScore: memory.relevanceScore,
                        type: memory.type
                    };
                } else {
                    return { content: String(memory), metadata: {} };
                }
            })
        };

        this.debugOutput.textContent = JSON.stringify(displayData, null, 2);
    }

    // ========== VOICE METHODS ==========

    async toggleVoiceMode() {
        const enabled = this.voiceEnabled.checked;
        
        if (enabled) {
            // Check if browser supports audio recording
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                this.showVoiceStatus('Voice recording not supported in this browser', 'error');
                this.voiceEnabled.checked = false;
                return;
            }
            
            try {
                // Request microphone permission
                await navigator.mediaDevices.getUserMedia({ audio: true });
                this.showVoiceStatus('Voice mode enabled - hold microphone button to record', 'success');
                this.recordBtn.disabled = false;
            } catch (error) {
                this.showVoiceStatus('Microphone access denied', 'error');
                this.voiceEnabled.checked = false;
            }
        } else {
            this.showVoiceStatus('Voice mode disabled', '');
            this.recordBtn.disabled = true;
            if (this.isRecording) {
                this.stopRecording();
            }
        }
    }

    async startRecording() {
        if (!this.voiceEnabled.checked || this.isRecording) return;
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100
                } 
            });
            
            this.audioChunks = [];
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                this.processRecording();
            };
            
            this.mediaRecorder.start();
            this.isRecording = true;
            this.recordBtn.classList.add('recording');
            this.showVoiceStatus('Recording... (release to send)', 'recording');
            
        } catch (error) {
            console.error('Failed to start recording:', error);
            this.showVoiceStatus('Failed to start recording: ' + error.message, 'error');
        }
    }

    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        
        this.mediaRecorder.stop();
        this.isRecording = false;
        this.recordBtn.classList.remove('recording');
        this.showVoiceStatus('Processing audio...', '');
    }

    async processRecording() {
        if (this.audioChunks.length === 0) {
            this.showVoiceStatus('No audio recorded', 'error');
            return;
        }
        
        try {
            // Create audio blob
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm;codecs=opus' });
            
            // Convert to wav for better compatibility
            const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
            
            this.showVoiceStatus('Sending voice message...', '');
            
            // Send voice chat request
            const formData = new FormData();
            formData.append('audio', audioFile);
            formData.append('conversation_id', this.conversationId);
            formData.append('output_voice', this.voiceSelect.value);
            formData.append('speech_speed', this.speechSpeed.value);
            formData.append('debug', 'true');
            
            const response = await fetch('/api/v1/voice/chat', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                const result = data.data;
                
                // Display transcription and response
                this.addMessage('user', result.transcription.text, true);
                this.addMessage('assistant', result.response);
                
                // Store audio response for playback
                this.lastAudioResponse = {
                    data: result.audio.data,
                    contentType: result.audio.contentType
                };
                this.playLastBtn.disabled = false;
                
                // Auto-play response if enabled
                if (this.voiceEnabled.checked) {
                    this.playAudioResponse(this.lastAudioResponse);
                }
                
                this.showVoiceStatus('Voice message processed successfully', 'success');
                
                // Update conversation ID if it changed
                if (result.conversation_id !== this.conversationId) {
                    this.conversationId = result.conversation_id;
                    this.conversationIdInput.value = this.conversationId;
                }
                
            } else {
                throw new Error(data.message || 'Voice processing failed');
            }
            
        } catch (error) {
            console.error('Voice processing error:', error);
            
            // Handle service unavailable errors
            if (error.message.includes('503')) {
                this.showVoiceStatus('Voice services not configured. Please set up Whisper and Piper servers first.', 'error');
            } else {
                this.showVoiceStatus('Voice processing failed: ' + error.message, 'error');
            }
        }
    }

    playLastResponse() {
        if (!this.lastAudioResponse) {
            this.showVoiceStatus('No audio response to play', 'error');
            return;
        }
        
        this.playAudioResponse(this.lastAudioResponse);
    }

    playAudioResponse(audioResponse) {
        try {
            // Stop any currently playing audio
            if (this.currentAudio) {
                this.currentAudio.pause();
                this.currentAudio = null;
            }
            
            // Convert base64 to audio blob
            const audioData = atob(audioResponse.data);
            const audioArray = new Uint8Array(audioData.length);
            for (let i = 0; i < audioData.length; i++) {
                audioArray[i] = audioData.charCodeAt(i);
            }
            
            const audioBlob = new Blob([audioArray], { type: audioResponse.contentType });
            const audioUrl = URL.createObjectURL(audioBlob);
            
            this.currentAudio = new Audio(audioUrl);
            
            this.currentAudio.onplay = () => {
                this.playLastBtn.classList.add('playing');
                this.showVoiceStatus('Playing AI response...', 'success');
            };
            
            this.currentAudio.onended = () => {
                this.playLastBtn.classList.remove('playing');
                this.showVoiceStatus('', '');
                URL.revokeObjectURL(audioUrl);
            };
            
            this.currentAudio.onerror = (error) => {
                console.error('Audio playback error:', error);
                this.playLastBtn.classList.remove('playing');
                this.showVoiceStatus('Audio playback failed', 'error');
                URL.revokeObjectURL(audioUrl);
            };
            
            this.currentAudio.play();
            
        } catch (error) {
            console.error('Failed to play audio:', error);
            this.showVoiceStatus('Failed to play audio: ' + error.message, 'error');
        }
    }

    async testVoice() {
        try {
            this.showVoiceStatus('Testing voice synthesis...', '');
            
            const response = await fetch('/api/v1/voice/text-to-speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: 'Hello! This is a voice test from Vortex AI. Voice synthesis is working correctly.',
                    voice: this.voiceSelect.value,
                    speed: parseFloat(this.speechSpeed.value),
                    output_format: 'wav'
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Play the audio response directly
            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            
            audio.onplay = () => {
                this.testVoiceBtn.textContent = 'Playing...';
                this.showVoiceStatus('Playing voice test...', 'success');
            };
            
            audio.onended = () => {
                this.testVoiceBtn.textContent = 'Test Voice';
                this.showVoiceStatus('Voice test completed', 'success');
                URL.revokeObjectURL(audioUrl);
            };
            
            audio.onerror = () => {
                this.testVoiceBtn.textContent = 'Test Voice';
                this.showVoiceStatus('Voice test playback failed', 'error');
                URL.revokeObjectURL(audioUrl);
            };
            
            audio.play();
            
        } catch (error) {
            console.error('Voice test error:', error);
            this.testVoiceBtn.textContent = 'Test Voice';
            
            // Handle service unavailable errors
            if (error.message.includes('503')) {
                this.showVoiceStatus('Voice services not configured. Check voice status for setup instructions.', 'error');
            } else {
                this.showVoiceStatus('Voice test failed: ' + error.message, 'error');
            }
        }
    }

    async checkVoiceStatus() {
        try {
            this.showVoiceStatus('Checking voice services...', '');
            
            const response = await fetch('/api/v1/voice/status', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                const status = data.data;
                let statusText = `Voice Services Status:\n`;
                statusText += `Overall: ${status.overall}\n`;
                statusText += `Whisper: ${status.whisper.status} (${status.whisper.url})\n`;
                statusText += `Piper: ${status.piper.status} (${status.piper.url})\n`;
                statusText += `Available Voices: ${status.piper.availableVoices.length}`;
                
                this.debugOutput.textContent = JSON.stringify(status, null, 2);
                
                if (status.overall === 'operational') {
                    this.showVoiceStatus('Voice services are operational', 'success');
                    
                    // Update voice options if available
                    if (status.piper.availableVoices && status.piper.availableVoices.length > 0) {
                        this.updateVoiceOptions(status.piper.availableVoices);
                    }
                } else {
                    this.showVoiceStatus('Voice services not configured - check debug panel for setup instructions', 'error');
                    
                    // Show setup instructions in debug output if available
                    if (status.setup_instructions) {
                        const setupInfo = {
                            ...status,
                            setup_guide: status.setup_instructions
                        };
                        this.debugOutput.textContent = JSON.stringify(setupInfo, null, 2);
                    }
                }
            } else {
                throw new Error(data.message || 'Failed to get voice status');
            }
            
        } catch (error) {
            console.error('Voice status check error:', error);
            this.showVoiceStatus('Voice status check failed: ' + error.message, 'error');
        }
    }

    updateVoiceOptions(voices) {
        // Clear existing options except defaults
        const currentValue = this.voiceSelect.value;
        this.voiceSelect.innerHTML = '';
        
        // Add available voices
        voices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice;
            option.textContent = this.formatVoiceName(voice);
            this.voiceSelect.appendChild(option);
        });
        
        // Restore previous selection if available
        if (voices.includes(currentValue)) {
            this.voiceSelect.value = currentValue;
        }
    }

    formatVoiceName(voice) {
        // Convert voice names like "en_US-amy-medium" to "English (US) - Lessac"
        const parts = voice.split('-');
        const locale = parts[0];
        const speaker = parts[1];
        const quality = parts[2];
        
        const localeMap = {
            'en_US': 'English (US)',
            'en_GB': 'English (UK)',
            'es_ES': 'Spanish',
            'fr_FR': 'French',
            'de_DE': 'German',
            'it_IT': 'Italian',
            'pt_BR': 'Portuguese (BR)'
        };
        
        const localeName = localeMap[locale] || locale;
        const speakerName = speaker ? speaker.charAt(0).toUpperCase() + speaker.slice(1) : '';
        
        return `${localeName} - ${speakerName}${quality ? ` (${quality})` : ''}`;
    }

    showVoiceStatus(message, type = '') {
        this.voiceStatus.textContent = message;
        this.voiceStatus.className = 'voice-status' + (type ? ` ${type}` : '');
        
        // Auto-clear success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                if (this.voiceStatus.classList.contains('success')) {
                    this.voiceStatus.textContent = '';
                    this.voiceStatus.className = 'voice-status';
                }
            }, 3000);
        }
    }


}

// Initialize the interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VortexDebugInterface();
});