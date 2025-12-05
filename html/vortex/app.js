class VortexDebugInterface {
    constructor() {
        console.log('VortexDebugInterface initialized');
        this.token = localStorage.getItem('vortex_token');
        this.user = null;
        this.conversationId = 'debug-' + Date.now();
        this.lastMemoryIntelligence = null;
        this.debugMode = true; // Debug mode enabled by default
        
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
        this.debugToggle = document.getElementById('debugToggle');
        this.newConversationBtn = document.getElementById('newConversationBtn');
        this.clearChatBtn = document.getElementById('clearChatBtn');
        this.debugTokenBtn = document.getElementById('debugTokenBtn');
        this.testMessageBtn = document.getElementById('testMessageBtn');
        
        // Memory Intelligence display elements
        this.evalImportance = document.getElementById('evalImportance');
        this.evalCategory = document.getElementById('evalCategory');
        this.evalStorageType = document.getElementById('evalStorageType');
        this.evalShouldStore = document.getElementById('evalShouldStore');
        this.evalKeyFacts = document.getElementById('evalKeyFacts');
        this.evalReasoning = document.getElementById('evalReasoning');
        this.storageDecisions = document.getElementById('storageDecisions');
        
        // Unified Analysis elements
        this.retrievalQueries = document.getElementById('retrievalQueries');
        this.retrievalCategories = document.getElementById('retrievalCategories');
        this.mcpIntentType = document.getElementById('mcpIntentType');
        this.mcpNeedsTools = document.getElementById('mcpNeedsTools');
        this.mcpConfidence = document.getElementById('mcpConfidence');
        
        // MCP Tools elements
        this.mcpStatus = document.getElementById('mcpStatus');
        this.mcpToolsList = document.getElementById('mcpToolsList');
        this.mcpSummary = document.getElementById('mcpSummary');
        
        // Context stats
        this.workingMemoryCount = document.getElementById('workingMemoryCount');
        this.semanticMemoryCount = document.getElementById('semanticMemoryCount');
        this.tokenEstimate = document.getElementById('tokenEstimate');
        
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
        
        // New buttons
        this.clearOutputBtn = document.getElementById('clearOutputBtn');
        this.summarizeBtn = document.getElementById('summarizeBtn');
        this.exportChatBtn = document.getElementById('exportChatBtn');
        this.checkLLMBtn = document.getElementById('checkLLMBtn');
        this.checkMemoryBtn = document.getElementById('checkMemoryBtn');
        this.checkVoiceSvcBtn = document.getElementById('checkVoiceSvcBtn');
        this.clearAllMemoriesBtn = document.getElementById('clearAllMemoriesBtn');
        
        // Knowledge base elements
        this.knowledgeTitle = document.getElementById('knowledgeTitle');
        this.knowledgeCategory = document.getElementById('knowledgeCategory');
        this.knowledgeContent = document.getElementById('knowledgeContent');
        this.addKnowledgeBtn = document.getElementById('addKnowledgeBtn');
        this.knowledgeFilterCategory = document.getElementById('knowledgeFilterCategory');
        this.knowledgeSearchQuery = document.getElementById('knowledgeSearchQuery');
        this.browseKnowledgeBtn = document.getElementById('browseKnowledgeBtn');
        this.searchKnowledgeBtn = document.getElementById('searchKnowledgeBtn');
        this.knowledgeList = document.getElementById('knowledgeList');
        this.knowledgeCount = document.getElementById('knowledgeCount');
        
        // File upload elements
        this.fileUploadArea = document.getElementById('fileUploadArea');
        this.knowledgeFileInput = document.getElementById('knowledgeFileInput');
        this.uploadProgress = document.getElementById('uploadProgress');
        this.progressFill = document.getElementById('progressFill');
        this.uploadStatus = document.getElementById('uploadStatus');
        this.uploadCategory = document.getElementById('uploadCategory');
        this.manualEntryHeader = document.getElementById('manualEntryHeader');
        
        // Voice-related properties
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.lastAudioResponse = null;
        this.currentAudio = null;
        
        // Set initial conversation ID
        if (this.conversationIdInput) {
            this.conversationIdInput.value = this.conversationId;
        }
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
        
        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });
        
        // Debug events
        if (this.debugToggle) this.debugToggle.addEventListener('click', () => this.toggleDebugMode());
        if (this.debugBtn) this.debugBtn.addEventListener('click', () => this.debugConversation());
        if (this.newConversationBtn) this.newConversationBtn.addEventListener('click', () => this.newConversation());
        if (this.clearChatBtn) this.clearChatBtn.addEventListener('click', () => this.clearChat());
        if (this.debugTokenBtn) this.debugTokenBtn.addEventListener('click', () => this.debugToken());
        if (this.testMessageBtn) this.testMessageBtn.addEventListener('click', () => this.testMessageDisplay());
        if (this.clearOutputBtn) this.clearOutputBtn.addEventListener('click', () => this.clearDebugOutput());
        
        // New action buttons
        if (this.summarizeBtn) this.summarizeBtn.addEventListener('click', () => this.summarizeConversation());
        if (this.exportChatBtn) this.exportChatBtn.addEventListener('click', () => this.exportChat());
        if (this.checkLLMBtn) this.checkLLMBtn.addEventListener('click', () => this.checkLLMStatus());
        if (this.checkMemoryBtn) this.checkMemoryBtn.addEventListener('click', () => this.checkMemoryStatus());
        if (this.checkVoiceSvcBtn) this.checkVoiceSvcBtn.addEventListener('click', () => this.checkVoiceStatus());
        if (this.clearAllMemoriesBtn) this.clearAllMemoriesBtn.addEventListener('click', () => this.clearAllMemories());
        
        // Knowledge base events
        if (this.addKnowledgeBtn) {
            console.log('addKnowledgeBtn found, binding click event');
            this.addKnowledgeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Add Knowledge button clicked');
                this.addKnowledge();
            });
        } else {
            console.warn('addKnowledgeBtn NOT found!');
        }
        if (this.browseKnowledgeBtn) this.browseKnowledgeBtn.addEventListener('click', () => this.browseKnowledge());
        if (this.searchKnowledgeBtn) this.searchKnowledgeBtn.addEventListener('click', () => this.searchKnowledge());
        if (this.knowledgeSearchQuery) this.knowledgeSearchQuery.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchKnowledge();
        });
        
        // File upload events
        if (this.knowledgeFileInput) this.knowledgeFileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        if (this.fileUploadArea) {
            this.fileUploadArea.addEventListener('click', (e) => {
                // Trigger file input when clicking the upload area
                if (!e.target.closest('select') && !e.target.closest('button')) {
                    this.knowledgeFileInput?.click();
                }
            });
            this.fileUploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
            this.fileUploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            this.fileUploadArea.addEventListener('drop', (e) => this.handleFileDrop(e));
        }
        if (this.manualEntryHeader) {
            this.manualEntryHeader.addEventListener('click', () => this.toggleManualEntry());
        }
        
        // Memory exploration events
        if (this.browseMemoriesBtn) this.browseMemoriesBtn.addEventListener('click', () => this.browseMemories());
        if (this.searchMemoriesBtn) this.searchMemoriesBtn.addEventListener('click', () => this.searchMemories());
        if (this.memorySearch) this.memorySearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchMemories();
        });
        if (this.conversationIdInput) this.conversationIdInput.addEventListener('change', (e) => {
            this.conversationId = e.target.value;
        });
        
        // Voice events
        if (this.recordBtn) {
            this.recordBtn.addEventListener('mousedown', () => this.startRecording());
            this.recordBtn.addEventListener('mouseup', () => this.stopRecording());
            this.recordBtn.addEventListener('mouseleave', () => this.stopRecording());
        }
        if (this.playLastBtn) this.playLastBtn.addEventListener('click', () => this.playLastResponse());
        if (this.testVoiceBtn) this.testVoiceBtn.addEventListener('click', () => this.testVoice());
        if (this.voiceStatusBtn) this.voiceStatusBtn.addEventListener('click', () => this.checkVoiceStatus());
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
            const response = await fetch(`/api/v1/vortex/chat?debug=${this.debugMode}`, {
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
                const memoryIntelligence = data.data?.memory_intelligence || data.memory_intelligence;
                
                // ===== PROGRESSIVE UI UPDATES =====
                
                // 1. Update unified analysis FIRST (from unified LLM call)
                if (debugInfo || memoryIntelligence) {
                    this.updateUnifiedAnalysis({ debug: debugInfo, memory_intelligence: memoryIntelligence });
                }
                
                // 2. Update memory intelligence panel
                if (memoryIntelligence) {
                    console.log('%c========== MEMORY INTELLIGENCE DEBUG ==========', 'color: #00ff00; font-weight: bold; font-size: 14px');
                    console.log('%c📊 User Message Evaluation:', 'color: #00bfff; font-weight: bold');
                    if (memoryIntelligence.user_evaluation) {
                        console.log('   Importance:', memoryIntelligence.user_evaluation.importance);
                        console.log('   Category:', memoryIntelligence.user_evaluation.category);
                        console.log('   Should Store:', memoryIntelligence.user_evaluation.shouldStore);
                        console.log('   Storage Type:', memoryIntelligence.user_evaluation.storageType);
                        console.log('   Key Facts:', memoryIntelligence.user_evaluation.keyFacts);
                        console.log('   Summary:', memoryIntelligence.user_evaluation.summary);
                        console.log('   Reasoning:', memoryIntelligence.user_evaluation.reasoning);
                    } else {
                        console.log('   (No evaluation available)');
                    }
                    console.log('%c📦 Storage Decisions:', 'color: #ff6b6b; font-weight: bold');
                    if (memoryIntelligence.storage_decisions && memoryIntelligence.storage_decisions.length > 0) {
                        memoryIntelligence.storage_decisions.forEach((decision, i) => {
                            let status = decision.stored ? '✅' : (decision.skipped ? '⏭️' : '❌');
                            let details = `Type: ${decision.type}, Importance: ${decision.importance}`;
                            if (decision.skipped) details += `, SKIPPED: ${decision.reason}`;
                            if (decision.stored) details += ', STORED';
                            if (decision.content) details += `, Content: "${decision.content}"`;
                            if (decision.usedSummary) details += ', Used Summary';
                            console.log(`   ${status} [${i + 1}] ${details}`);
                        });
                    } else {
                        console.log('   (No storage decisions)');
                    }
                    console.log('%c🔍 Query Enhancement:', 'color: #ff9500; font-weight: bold');
                    if (memoryIntelligence.query_enhancement) {
                        console.log('   Queries Used:', memoryIntelligence.query_enhancement.queries_used);
                        console.log('   Categories:', memoryIntelligence.query_enhancement.categories);
                    } else {
                        console.log('   (No enhancement available)');
                    }
                    console.log('%c================================================', 'color: #00ff00; font-weight: bold');
                    console.log('Full memory_intelligence object:', memoryIntelligence);
                    
                    // Update the UI panel with memory intelligence
                    this.updateMemoryIntelligencePanel(memoryIntelligence);
                }
                
                // 3. Update MCP section
                if (debugInfo) {
                    this.updateMCPSection({ debug: debugInfo });
                }
                
                // 4. Finally, show AI response
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
        // Format LLM request/response nicely if present
        let formattedText = `=== Debug Info (${new Date().toISOString()}) ===\n`;
        formattedText += `Conversation ID: ${this.conversationId}\n\n`;
        
        // LLM Request
        if (debugData.llm_request) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `📤 LLM REQUEST\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            
            formattedText += `--- SYSTEM PROMPT ---\n`;
            formattedText += `${debugData.llm_request.system_prompt || 'N/A'}\n\n`;
            
            formattedText += `--- CONVERSATION CONTEXT (${debugData.llm_request.messages?.length || 0} messages) ---\n`;
            if (debugData.llm_request.messages) {
                debugData.llm_request.messages.forEach((msg, i) => {
                    formattedText += `[${i + 1}] ${msg.role.toUpperCase()}:\n${msg.content}\n\n`;
                });
            }
            
            formattedText += `Temperature: ${debugData.llm_request.temperature}\n`;
            formattedText += `Max Tokens: ${debugData.llm_request.max_tokens}\n\n`;
        }
        
        // LLM Response
        if (debugData.llm_response) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `📥 LLM RESPONSE\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            
            formattedText += `Model: ${debugData.llm_response.model || 'N/A'}\n`;
            formattedText += `Tokens Used: ${debugData.llm_response.tokens_used || 'N/A'}\n`;
            formattedText += `Response Length: ${debugData.llm_response.response_chars || 0} chars\n`;
            formattedText += `Actions Detected: ${debugData.llm_response.actions_detected || 0}\n\n`;
            
            formattedText += `--- FULL RESPONSE ---\n`;
            formattedText += `${debugData.llm_response.full_response || 'N/A'}\n\n`;
            
            if (debugData.llm_response.actions && debugData.llm_response.actions.length > 0) {
                formattedText += `--- ACTIONS ---\n`;
                debugData.llm_response.actions.forEach((action, i) => {
                    formattedText += `[${i + 1}] ${action.type}: ${action.content}\n`;
                });
                formattedText += '\n';
            }
        }
        
        // Memory Intelligence Summary
        if (debugData.memory_intelligence) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `🧠 MEMORY INTELLIGENCE\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            formattedText += JSON.stringify(debugData.memory_intelligence, null, 2) + '\n\n';
        }
        
        // MCP / Tools Summary
        if (debugData.mcp) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `🔧 MCP / TOOLS\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            
            // First, show raw response for debugging
            formattedText += `--- RAW MCP RESPONSE ---\n`;
            formattedText += JSON.stringify(debugData.mcp, null, 2) + '\n\n';
            
            formattedText += `--- PARSED INFO ---\n`;
            formattedText += `Needs Tools: ${debugData.mcp.needsTools || false}\n`;
            
            // Show reason if tools were not needed
            if (!debugData.mcp.needsTools && debugData.mcp.reason) {
                formattedText += `Reason: ${debugData.mcp.reason}\n`;
                if (debugData.mcp.serversConfigured !== undefined) {
                    formattedText += `Servers Configured: ${debugData.mcp.serversConfigured}\n`;
                    formattedText += `Servers Enabled: ${debugData.mcp.serversEnabled}\n`;
                }
                if (debugData.mcp.availableCategories) {
                    formattedText += `Available Categories: ${JSON.stringify(debugData.mcp.availableCategories)}\n`;
                }
            }
            
            // Show intent classification if available
            if (debugData.mcp.intent) {
                formattedText += `\n--- INTENT CLASSIFICATION ---\n`;
                formattedText += `Categories: ${JSON.stringify(debugData.mcp.intent.categories || [])}\n`;
                formattedText += `Confidence: ${debugData.mcp.intent.confidence || 'N/A'}\n`;
                formattedText += `Reasoning: ${debugData.mcp.intent.reasoning || 'N/A'}\n`;
            }
            
            if (debugData.mcp.toolsUsed && debugData.mcp.toolsUsed.length > 0) {
                formattedText += `\n--- TOOLS USED ---\n`;
                debugData.mcp.toolsUsed.forEach((tool, i) => {
                    formattedText += `[${i + 1}] ${tool}\n`;
                });
            }
            if (debugData.mcp.toolResults && debugData.mcp.toolResults.length > 0) {
                formattedText += `\n--- TOOL RESULTS ---\n`;
                debugData.mcp.toolResults.forEach((result, i) => {
                    formattedText += `[${i + 1}] ${result.tool}: ${result.success ? '✅' : '❌'}\n`;
                    if (result.result) {
                        const resultStr = typeof result.result === 'object' 
                            ? JSON.stringify(result.result, null, 2).split('\n').map(l => '    ' + l).join('\n')
                            : '    ' + result.result;
                        formattedText += `${resultStr}\n`;
                    }
                    if (result.error) {
                        formattedText += `    Error: ${result.error}\n`;
                    }
                });
            }
            
            // Show context that was injected into LLM
            if (debugData.mcp.contextForLLM) {
                formattedText += `\n--- CONTEXT INJECTED TO LLM ---\n`;
                formattedText += `${debugData.mcp.contextForLLM}\n`;
            }
            
            if (debugData.mcp.error) {
                formattedText += `\n⚠️ MCP Error: ${debugData.mcp.error}\n`;
            }
            formattedText += '\n';
        }
        
        // Memory Summary
        if (debugData.memory) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `💾 MEMORY RETRIEVED\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            formattedText += JSON.stringify(debugData.memory, null, 2) + '\n\n';
        }
        
        // Any remaining debug data
        const shown = ['llm_request', 'llm_response', 'memory_intelligence', 'mcp', 'memory', 'prompt'];
        const remaining = Object.keys(debugData).filter(k => !shown.includes(k));
        if (remaining.length > 0) {
            formattedText += `${'='.repeat(60)}\n`;
            formattedText += `📋 OTHER DEBUG INFO\n`;
            formattedText += `${'='.repeat(60)}\n\n`;
            const otherData = {};
            remaining.forEach(k => otherData[k] = debugData[k]);
            formattedText += JSON.stringify(otherData, null, 2);
        }
        
        this.debugOutput.textContent = formattedText;
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
            
            console.log('Voice chat response:', JSON.stringify(data, null, 2));
            
            if (data.success) {
                const result = data.data;
                
                console.log('Transcription result:', result.transcription);
                console.log('AI response:', result.response);
                
                // ===== PROGRESSIVE UI UPDATES =====
                
                // Log memory intelligence to browser console for debugging
                const memoryIntelligence = result.memory_intelligence;
                if (memoryIntelligence) {
                    // 1. Update unified analysis first
                    this.updateUnifiedAnalysis({ 
                        debug: result.debug, 
                        memory_intelligence: memoryIntelligence 
                    });
                    
                    console.log('%c========== MEMORY INTELLIGENCE DEBUG (VOICE) ==========', 'color: #00ff00; font-weight: bold; font-size: 14px');
                    console.log('%c📊 User Message Evaluation:', 'color: #00bfff; font-weight: bold');
                    if (memoryIntelligence.user_evaluation) {
                        console.log('   Importance:', memoryIntelligence.user_evaluation.importance);
                        console.log('   Category:', memoryIntelligence.user_evaluation.category);
                        console.log('   Should Store:', memoryIntelligence.user_evaluation.shouldStore);
                        console.log('   Storage Type:', memoryIntelligence.user_evaluation.storageType);
                        console.log('   Key Facts:', memoryIntelligence.user_evaluation.keyFacts);
                        console.log('   Summary:', memoryIntelligence.user_evaluation.summary);
                        console.log('   Reasoning:', memoryIntelligence.user_evaluation.reasoning);
                    } else {
                        console.log('   (No evaluation available)');
                    }
                    console.log('%c📦 Storage Decisions:', 'color: #ff6b6b; font-weight: bold');
                    if (memoryIntelligence.storage_decisions && memoryIntelligence.storage_decisions.length > 0) {
                        memoryIntelligence.storage_decisions.forEach((decision, i) => {
                            let status = decision.stored ? '✅' : (decision.skipped ? '⏭️' : '❌');
                            let details = `Type: ${decision.type}, Importance: ${decision.importance}`;
                            if (decision.skipped) details += `, SKIPPED: ${decision.reason}`;
                            if (decision.stored) details += ', STORED';
                            if (decision.content) details += `, Content: "${decision.content}"`;
                            if (decision.usedSummary) details += ', Used Summary';
                            console.log(`   ${status} [${i + 1}] ${details}`);
                        });
                    } else {
                        console.log('   (No storage decisions)');
                    }
                    console.log('%c🔍 Query Enhancement:', 'color: #ff9500; font-weight: bold');
                    if (memoryIntelligence.query_enhancement) {
                        console.log('   Queries Used:', memoryIntelligence.query_enhancement.queries_used);
                        console.log('   Categories:', memoryIntelligence.query_enhancement.categories);
                    } else {
                        console.log('   (No enhancement available)');
                    }
                    console.log('%c=========================================================', 'color: #00ff00; font-weight: bold');
                    console.log('Full memory_intelligence object:', memoryIntelligence);
                    
                    // 2. Update the UI panel with memory intelligence
                    this.updateMemoryIntelligencePanel(memoryIntelligence);
                }
                
                // 3. Update MCP section
                if (result.debug) {
                    this.updateMCPSection({ debug: result.debug });
                }
                
                // Display transcription and response
                const userText = result.transcription?.text || '[transcription empty]';
                this.addMessage('user', userText, true);
                this.addMessage('assistant', result.response || '[no response]');
                
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
                const voiceCount = status.piper?.availableVoices?.length || 0;
                
                let statusText = `Voice Services Status:\n`;
                statusText += `Overall: ${status.overall || 'unknown'}\n`;
                statusText += `Whisper: ${status.whisper?.status || 'unknown'} (${status.whisper?.url || 'not configured'})\n`;
                statusText += `Piper: ${status.piper?.status || 'unknown'} (${status.piper?.url || 'not configured'})\n`;
                statusText += `Available Voices: ${voiceCount}`;
                
                this.debugOutput.textContent = JSON.stringify(status, null, 2);
                
                if (status.overall === 'operational') {
                    this.showVoiceStatus('Voice services are operational', 'success');
                    
                    // Update voice options if available
                    if (status.piper?.availableVoices && status.piper.availableVoices.length > 0) {
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

    // ========== TAB SWITCHING ==========

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        
        // Update tab panels - the HTML uses id="tab-{name}" format
        document.querySelectorAll('.tab-content').forEach(panel => {
            panel.classList.toggle('active', panel.id === 'tab-' + tabName);
        });
    }

    // ========== MEMORY INTELLIGENCE DISPLAY ==========

    updateMemoryIntelligencePanel(memoryIntelligence) {
        if (!memoryIntelligence) {
            console.log('No memory intelligence data received');
            return;
        }
        
        console.log('Updating memory intelligence panel:', memoryIntelligence);
        this.lastMemoryIntelligence = memoryIntelligence;
        
        // Update User Evaluation section
        const userEval = memoryIntelligence.user_evaluation;
        console.log('User evaluation:', userEval);
        
        if (userEval) {
            // Importance with color coding
            if (this.evalImportance) {
                const importance = userEval.importance || 0;
                this.evalImportance.textContent = importance;
                const importanceClass = importance >= 7 ? 'high' : importance >= 4 ? 'medium' : 'low';
                this.evalImportance.className = `eval-value importance-badge importance-${importanceClass}`;
            }
            
            // Category
            if (this.evalCategory) {
                this.evalCategory.textContent = userEval.category || 'unknown';
            }
            
            // Storage Type
            if (this.evalStorageType) {
                this.evalStorageType.textContent = userEval.storageType || 'none';
            }
            
            // Should Store
            if (this.evalShouldStore) {
                const shouldStore = userEval.shouldStore;
                this.evalShouldStore.textContent = shouldStore ? 'YES' : 'NO';
                this.evalShouldStore.className = `stat-value ${shouldStore ? 'store-yes' : 'store-no'}`;
            }
            
            // Key Facts
            if (this.evalKeyFacts) {
                const keyFacts = userEval.keyFacts || [];
                if (keyFacts.length > 0) {
                    this.evalKeyFacts.textContent = keyFacts.join(', ');
                } else {
                    this.evalKeyFacts.textContent = '-';
                }
            }
            
            // Reasoning
            if (this.evalReasoning) {
                this.evalReasoning.textContent = userEval.reasoning || 'No reasoning provided';
            }
        }
        
        // Update Storage Decisions section
        if (this.storageDecisions) {
            const decisions = memoryIntelligence.storage_decisions || [];
            if (decisions.length > 0) {
                this.storageDecisions.innerHTML = decisions.map(decision => {
                    const statusIcon = decision.stored ? '✅' : (decision.skipped ? '⏭️' : '❌');
                    const statusClass = decision.stored ? 'stored' : (decision.skipped ? 'skipped' : 'failed');
                    
                    return `
                        <div class="storage-decision ${statusClass}">
                            <span class="decision-icon">${statusIcon}</span>
                            <div class="decision-details">
                                <span class="decision-type">${decision.type}</span>
                                <span class="decision-importance">Importance: ${decision.importance}</span>
                                ${decision.reason ? `<span class="decision-reason">${decision.reason}</span>` : ''}
                                ${decision.content ? `<span class="decision-content">"${this.escapeHtml(decision.content.substring(0, 50))}..."</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                this.storageDecisions.innerHTML = '<div class="no-data">No storage decisions yet</div>';
            }
        }
        
        // Update Context Stats section from query_enhancement
        if (memoryIntelligence.query_enhancement) {
            const qe = memoryIntelligence.query_enhancement;
            if (this.workingMemoryCount) this.workingMemoryCount.textContent = qe.queries_used || 0;
            if (this.semanticMemoryCount) this.semanticMemoryCount.textContent = (qe.categories || []).length;
        }
        
        // Update storage decisions count
        const decisionsCount = (memoryIntelligence.storage_decisions || []).length;
        if (this.tokenEstimate) {
            this.tokenEstimate.textContent = decisionsCount;
        }
    }

    updateUnifiedAnalysis(data) {
        console.log('Updating unified analysis:', data);
        
        // Try to get unified analysis from multiple sources
        let unifiedAnalysis = null;
        
        // Priority 1: memory_intelligence.unified_analysis (always available)
        if (data.memory_intelligence?.unified_analysis) {
            unifiedAnalysis = data.memory_intelligence.unified_analysis;
        }
        // Priority 2: debug.unified_analysis (when debug=true)
        else if (data.debug?.unified_analysis) {
            unifiedAnalysis = data.debug.unified_analysis;
        }
        
        // Update retrieval section from memory_intelligence or unified_analysis
        const mi = data.memory_intelligence;
        if (mi) {
            // Retrieval queries and categories
            if (mi.query_enhancement) {
                const queries = mi.query_enhancement.queries || [];
                const categories = mi.query_enhancement.categories || [];
                
                if (this.retrievalQueries) {
                    this.retrievalQueries.innerHTML = queries.length > 0 
                        ? queries.map(q => `<div class="query-tag">${this.escapeHtml(q)}</div>`).join('')
                        : '<span class="no-data">No queries</span>';
                }
                
                if (this.retrievalCategories) {
                    this.retrievalCategories.innerHTML = categories.length > 0
                        ? categories.map(c => `<span class="category-tag">${c}</span>`).join(' ')
                        : '<span class="no-data">None</span>';
                }
            }
        }
        
        // Update MCP Intent section from unified analysis
        if (unifiedAnalysis?.mcpIntent) {
            const intent = unifiedAnalysis.mcpIntent;
            
            if (this.mcpIntentType) {
                this.mcpIntentType.textContent = intent.intentType || 'unknown';
                this.mcpIntentType.className = `analysis-value intent-${intent.intentType || 'unknown'}`;
            }
            
            if (this.mcpNeedsTools) {
                const needsTools = intent.needsTools || false;
                this.mcpNeedsTools.textContent = needsTools ? 'YES' : 'NO';
                this.mcpNeedsTools.className = `analysis-value badge ${needsTools ? 'badge-yes' : 'badge-no'}`;
            }
            
            if (this.mcpConfidence) {
                const confidence = intent.confidence || 0;
                this.mcpConfidence.textContent = `${(confidence * 100).toFixed(0)}%`;
                const confidenceClass = confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'medium' : 'low';
                this.mcpConfidence.className = `analysis-value confidence-${confidenceClass}`;
            }
        }
        
        // Also update retrieval from unified_analysis if not set from query_enhancement
        if (unifiedAnalysis?.retrieval && !mi?.query_enhancement) {
            if (this.retrievalQueries && unifiedAnalysis.retrieval.queries) {
                this.retrievalQueries.innerHTML = unifiedAnalysis.retrieval.queries.length > 0 
                    ? unifiedAnalysis.retrieval.queries.map(q => `<div class="query-tag">${this.escapeHtml(q)}</div>`).join('')
                    : '<span class="no-data">No queries</span>';
            }
            
            if (this.retrievalCategories && unifiedAnalysis.retrieval.categories) {
                this.retrievalCategories.innerHTML = unifiedAnalysis.retrieval.categories.length > 0
                    ? unifiedAnalysis.retrieval.categories.map(c => `<span class="category-tag">${c}</span>`).join(' ')
                    : '<span class="no-data">None</span>';
            }
        }
    }

    updateMCPSection(data) {
        console.log('Updating MCP section:', data);
        console.log('MCP data received:', data.debug?.mcp);
        
        // Check debug.mcp for detailed info
        const mcpData = data.debug?.mcp;
        
        if (!mcpData) {
            if (this.mcpStatus) {
                this.mcpStatus.innerHTML = '<span class="mcp-not-called">MCP not invoked</span>';
            }
            if (this.mcpToolsList) this.mcpToolsList.style.display = 'none';
            if (this.mcpSummary) this.mcpSummary.style.display = 'none';
            return;
        }
        
        // MCP was skipped
        if (mcpData.skipped) {
            if (this.mcpStatus) {
                this.mcpStatus.innerHTML = `
                    <div class="mcp-skipped">
                        <span class="status-icon">⏭️</span>
                        <span class="status-text">Skipped: ${mcpData.reason || 'Not needed'}</span>
                    </div>
                `;
            }
            if (this.mcpToolsList) this.mcpToolsList.style.display = 'none';
            if (this.mcpSummary) this.mcpSummary.style.display = 'none';
            return;
        }
        
        // MCP had an error (and no tools were successfully used)
        if (mcpData.error && !mcpData.toolsUsed) {
            if (this.mcpStatus) {
                this.mcpStatus.innerHTML = `
                    <div class="mcp-error">
                        <span class="status-icon">❌</span>
                        <span class="status-text">Error: ${this.escapeHtml(mcpData.error)}</span>
                    </div>
                `;
            }
            if (this.mcpToolsList) this.mcpToolsList.style.display = 'none';
            if (this.mcpSummary) this.mcpSummary.style.display = 'none';
            return;
        }
        
        // MCP was called successfully - check if tools were actually used
        // The mcpResult is spread directly, so properties are at top level
        if (mcpData.toolsUsed && mcpData.toolsUsed.length > 0) {
            console.log('MCP tools were used:', mcpData.toolsUsed);
            console.log('mcpStatus element:', this.mcpStatus);
            console.log('mcpToolsList element:', this.mcpToolsList);
            console.log('mcpSummary element:', this.mcpSummary);
            
            if (this.mcpStatus) {
                const statusHTML = `
                    <div class="mcp-success">
                        <span class="status-icon">✅</span>
                        <span class="status-text">Tools executed successfully</span>
                    </div>
                `;
                console.log('Setting status HTML:', statusHTML);
                this.mcpStatus.innerHTML = statusHTML;
                console.log('Status after set:', this.mcpStatus.innerHTML);
            }
            
            // Show tools used
            if (this.mcpToolsList) {
                this.mcpToolsList.style.display = 'block';
                this.mcpToolsList.innerHTML = `
                    <h5>Tools Used:</h5>
                    ${mcpData.toolsUsed.map((tool, i) => {
                        const toolResult = mcpData.toolResults?.[i];
                        return `
                            <div class="mcp-tool">
                                <div class="tool-name">🔧 ${tool}</div>
                                ${toolResult ? `<div class="tool-result">${this.escapeHtml(JSON.stringify(toolResult, null, 2))}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                `;
                console.log('Tools list after set:', this.mcpToolsList.innerHTML.substring(0, 100));
            }
            
            // Show LLM summary
            if (this.mcpSummary && mcpData.llmSummary) {
                this.mcpSummary.style.display = 'block';
                this.mcpSummary.innerHTML = `
                    <h5>MCP Summary:</h5>
                    <div class="summary-text">${this.escapeHtml(mcpData.llmSummary)}</div>
                `;
                console.log('Summary after set:', this.mcpSummary.innerHTML.substring(0, 100));
            } else if (this.mcpSummary) {
                this.mcpSummary.style.display = 'none';
            }
        } else if (mcpData.needsTools === false) {
            // MCP was called but determined no tools needed
            console.log('MCP determined no tools needed');
            
            if (this.mcpStatus) {
                this.mcpStatus.innerHTML = `
                    <div class="mcp-skipped">
                        <span class="status-icon">ℹ️</span>
                        <span class="status-text">No tools needed</span>
                    </div>
                `;
            }
            if (this.mcpToolsList) this.mcpToolsList.style.display = 'none';
            if (this.mcpSummary) this.mcpSummary.style.display = 'none';
        } else {
            // Fallback: MCP data exists but unclear state
            console.warn('MCP data in unclear state:', mcpData);
            
            if (this.mcpStatus) {
                this.mcpStatus.innerHTML = `
                    <div class="mcp-skipped">
                        <span class="status-icon">❓</span>
                        <span class="status-text">Status unclear</span>
                    </div>
                `;
            }
            if (this.mcpToolsList) this.mcpToolsList.style.display = 'none';
            if (this.mcpSummary) this.mcpSummary.style.display = 'none';
        }
    }

    // ========== NEW ACTION METHODS ==========

    toggleDebugMode() {
        this.debugMode = !this.debugMode;
        if (this.debugToggle) {
            this.debugToggle.classList.toggle('active', this.debugMode);
            this.debugToggle.title = this.debugMode ? 'Debug mode ON - Click to disable' : 'Debug mode OFF - Click to enable';
        }
        this.addMessage('system', `🐛 Debug mode ${this.debugMode ? 'enabled' : 'disabled'}`);
        console.log('Debug mode:', this.debugMode);
    }

    clearDebugOutput() {
        if (this.debugOutput) {
            this.debugOutput.textContent = '';
        }
    }

    async summarizeConversation() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        try {
            this.debugOutput.textContent = 'Generating conversation summary...';
            
            const response = await fetch(`/api/v1/vortex/conversation/${this.conversationId}/summary`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to summarize'}`;
            }
        } catch (error) {
            console.error('Summarize error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    exportChat() {
        const messages = [];
        const messageElements = this.chatMessages.querySelectorAll('.message');
        
        messageElements.forEach(msgEl => {
            const role = msgEl.querySelector('.role')?.textContent || 'unknown';
            const content = msgEl.querySelector('.message-content')?.textContent || '';
            const timestamp = msgEl.querySelector('.timestamp')?.textContent || '';
            messages.push({ role, content, timestamp });
        });

        const exportData = {
            conversation_id: this.conversationId,
            exported_at: new Date().toISOString(),
            message_count: messages.length,
            messages
        };

        // Download as JSON file
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vortex-chat-${this.conversationId}-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.addMessage('system', `📤 Chat exported (${messages.length} messages)`);
    }

    async checkLLMStatus() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        try {
            this.debugOutput.textContent = 'Checking LLM status...';
            
            const response = await fetch('/api/v1/vortex/status/llm', {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            this.debugOutput.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
            console.error('LLM status error:', error);
            this.debugOutput.textContent = `LLM Status Check Failed:\n${error.message}`;
        }
    }

    async checkMemoryStatus() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        try {
            this.debugOutput.textContent = 'Checking memory service status...';
            
            const response = await fetch('/api/v1/vortex/status/memory', {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            this.debugOutput.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
            console.error('Memory status error:', error);
            this.debugOutput.textContent = `Memory Status Check Failed:\n${error.message}`;
        }
    }

    async clearAllMemories() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        if (!confirm('⚠️ This will delete ALL your memories. Are you sure?')) {
            return;
        }

        try {
            this.debugOutput.textContent = 'Clearing all memories...';
            
            const response = await fetch('/api/v1/vortex/memory/clear', {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
                this.addMessage('system', '🗑️ All memories cleared');
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to clear memories'}`;
            }
        } catch (error) {
            console.error('Clear memories error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    // ========================================
    // Knowledge Base Methods
    // ========================================

    async addKnowledge() {
        console.log('addKnowledge() called');
        console.log('Token:', this.token ? 'exists' : 'missing');
        console.log('Title element:', this.knowledgeTitle);
        console.log('Content element:', this.knowledgeContent);
        
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        const title = this.knowledgeTitle?.value?.trim();
        const content = this.knowledgeContent?.value?.trim();
        const category = this.knowledgeCategory?.value || 'general';
        
        console.log('Title value:', title);
        console.log('Content value:', content);
        console.log('Category:', category);

        if (!title || !content) {
            this.debugOutput.textContent = 'Error: Title and content are required.';
            return;
        }

        try {
            this.debugOutput.textContent = 'Adding knowledge document...';
            
            const response = await fetch('/api/v1/vortex/knowledge', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title,
                    content,
                    category,
                    source: 'manual'
                })
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
                
                if (data.data?.skipped) {
                    this.addMessage('system', `⏭️ Knowledge skipped (duplicate): ${title}`);
                } else {
                    this.addMessage('system', `✅ Knowledge added: ${title}`);
                    // Clear inputs after successful add
                    this.knowledgeTitle.value = '';
                    this.knowledgeContent.value = '';
                    // Refresh the list
                    this.browseKnowledge();
                }
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to add knowledge'}`;
            }
        } catch (error) {
            console.error('Add knowledge error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    async browseKnowledge() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        try {
            this.debugOutput.textContent = 'Loading knowledge documents...';
            
            const category = this.knowledgeFilterCategory?.value || '';
            const url = category 
                ? `/api/v1/vortex/knowledge?category=${encodeURIComponent(category)}`
                : '/api/v1/vortex/knowledge';
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
                this.renderKnowledgeList(data.data?.documents || []);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Failed to load knowledge'}`;
                this.knowledgeList.innerHTML = '<span class="placeholder">Failed to load documents</span>';
            }
        } catch (error) {
            console.error('Browse knowledge error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
            this.knowledgeList.innerHTML = '<span class="placeholder">Network error</span>';
        }
    }

    async searchKnowledge() {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        const query = this.knowledgeSearchQuery?.value?.trim();
        if (!query) {
            this.debugOutput.textContent = 'Error: Search query is required.';
            return;
        }

        try {
            this.debugOutput.textContent = `Searching knowledge for: "${query}"...`;
            
            const response = await fetch(`/api/v1/vortex/knowledge/search?query=${encodeURIComponent(query)}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
                this.renderKnowledgeList(data.data?.documents || [], true);
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Search failed'}`;
            }
        } catch (error) {
            console.error('Search knowledge error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    async deleteKnowledge(id, title) {
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        if (!confirm(`Delete knowledge document: "${title}"?`)) {
            return;
        }

        try {
            this.debugOutput.textContent = `Deleting: ${title}...`;
            
            const response = await fetch(`/api/v1/vortex/knowledge/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            
            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
                this.addMessage('system', `🗑️ Deleted: ${title}`);
                // Refresh the list
                this.browseKnowledge();
            } else {
                this.debugOutput.textContent = `Error (${response.status}): ${data.message || 'Delete failed'}`;
            }
        } catch (error) {
            console.error('Delete knowledge error:', error);
            this.debugOutput.textContent = `Network error: ${error.message}`;
        }
    }

    renderKnowledgeList(documents, isSearch = false) {
        if (!this.knowledgeList) return;
        
        // Update count badge
        if (this.knowledgeCount) {
            this.knowledgeCount.textContent = documents.length;
        }

        if (!documents || documents.length === 0) {
            this.knowledgeList.innerHTML = `<span class="placeholder">${isSearch ? 'No matching documents found' : 'No documents in knowledge base'}</span>`;
            return;
        }

        const getCategoryEmoji = (category) => {
            const emojis = {
                'general': '📁',
                'documentation': '📖',
                'reference': '📋',
                'guide': '📝',
                'personal': '👤',
                'technical': '⚙️'
            };
            return emojis[category] || '📄';
        };

        const html = documents.map(doc => {
            const preview = doc.content?.substring(0, 150) + (doc.content?.length > 150 ? '...' : '');
            const category = doc.metadata?.category || 'general';
            const distance = doc.distance !== undefined ? ` (${(1 - doc.distance).toFixed(2)} match)` : '';
            const timestamp = doc.metadata?.timestamp ? new Date(doc.metadata.timestamp).toLocaleDateString() : '';
            const chunkCount = doc.chunkCount || doc.metadata?.total_chunks || 1;
            const contentLength = doc.metadata?.content_length || doc.content?.length || 0;
            
            return `
                <div class="knowledge-item" data-id="${doc.id}">
                    <div class="knowledge-header">
                        <span class="knowledge-title">${getCategoryEmoji(category)} ${doc.title || doc.metadata?.title || 'Untitled'}</span>
                        <button class="btn-tiny btn-danger delete-knowledge-btn" data-id="${doc.id}" data-title="${doc.title || doc.metadata?.title || 'Untitled'}">🗑️</button>
                    </div>
                    <div class="knowledge-meta">
                        <span class="knowledge-category">${category}</span>
                        <span class="knowledge-chunks">${chunkCount} chunk${chunkCount > 1 ? 's' : ''}</span>
                        <span class="knowledge-size">${this.formatFileSize(contentLength)}</span>
                        ${timestamp ? `<span class="knowledge-date">${timestamp}</span>` : ''}
                        ${distance ? `<span class="knowledge-distance">${distance}</span>` : ''}
                    </div>
                    <div class="knowledge-preview">${preview}</div>
                </div>
            `;
        }).join('');

        this.knowledgeList.innerHTML = html;

        // Add delete event listeners
        this.knowledgeList.querySelectorAll('.delete-knowledge-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const title = btn.dataset.title;
                this.deleteKnowledge(id, title);
            });
        });

        // Add click event to show full content
        this.knowledgeList.querySelectorAll('.knowledge-item').forEach(item => {
            item.addEventListener('click', () => {
                const doc = documents.find(d => d.id === item.dataset.id);
                if (doc) {
                    this.debugOutput.textContent = JSON.stringify(doc, null, 2);
                }
            });
        });
    }

    // ========================================
    // File Upload Methods
    // ========================================

    toggleManualEntry() {
        const card = this.manualEntryHeader?.closest('.collapsible');
        if (card) {
            card.classList.toggle('collapsed');
        }
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadArea?.classList.add('drag-over');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadArea?.classList.remove('drag-over');
    }

    handleFileDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadArea?.classList.remove('drag-over');
        
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            this.processFile(files[0]);
        }
    }

    handleFileSelect(e) {
        const files = e.target?.files;
        if (files && files.length > 0) {
            this.processFile(files[0]);
        }
    }

    async processFile(file) {
        console.log('processFile called with:', file.name, file.type, file.size);
        
        if (!this.token) {
            this.debugOutput.textContent = 'Error: Not authenticated. Please login first.';
            return;
        }

        // Check for empty file
        if (file.size === 0) {
            this.debugOutput.textContent = `Error: File "${file.name}" is empty (0 bytes). Please select a file with content.`;
            return;
        }

        const maxSize = 10 * 1024 * 1024; // 10MB limit
        if (file.size > maxSize) {
            this.debugOutput.textContent = `Error: File too large. Maximum size is 10MB.`;
            return;
        }

        // Show progress
        const uploadPrompt = this.fileUploadArea?.querySelector('.upload-prompt');
        if (uploadPrompt) uploadPrompt.style.display = 'none';
        if (this.uploadProgress) this.uploadProgress.style.display = 'flex';
        if (this.progressFill) this.progressFill.style.width = '10%';
        if (this.uploadStatus) this.uploadStatus.textContent = `Reading: ${file.name}...`;

        try {
            // Extract text content from file
            console.log('Calling extractFileContent...');
            const content = await this.extractFileContent(file);
            console.log('extractFileContent returned, content length:', content?.length);
            
            if (this.progressFill) this.progressFill.style.width = '50%';
            if (this.uploadStatus) this.uploadStatus.textContent = 'Uploading to knowledge base...';

            if (!content || content.trim().length === 0) {
                console.error('Content is empty after extraction');
                throw new Error('Could not extract text content from file (empty result)');
            }

            // Get category
            const category = this.uploadCategory?.value || 'documentation';
            
            // Upload to knowledge base
            const response = await fetch('/api/v1/vortex/knowledge', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title: file.name,
                    content: content,
                    category: category,
                    source: `file:${file.name}`,
                    metadata: {
                        originalName: file.name,
                        fileType: file.type,
                        fileSize: file.size
                    }
                })
            });

            if (this.progressFill) this.progressFill.style.width = '90%';

            const data = await response.json();
            
            if (response.ok) {
                if (this.progressFill) this.progressFill.style.width = '100%';
                
                if (data.data?.skipped) {
                    if (this.uploadStatus) this.uploadStatus.textContent = `⏭️ Skipped (duplicate): ${file.name}`;
                    this.addMessage('system', `⏭️ File skipped (duplicate): ${file.name}`);
                } else {
                    if (this.uploadStatus) this.uploadStatus.textContent = `✅ Uploaded: ${file.name}`;
                    this.addMessage('system', `✅ File uploaded: ${file.name} (${this.formatFileSize(file.size)})`);
                    // Refresh the list
                    this.browseKnowledge();
                }
                
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
            } else {
                throw new Error(data.message || 'Upload failed');
            }

        } catch (error) {
            console.error('File upload error:', error);
            if (this.uploadStatus) this.uploadStatus.textContent = `❌ Error: ${error.message}`;
            this.debugOutput.textContent = `File upload failed: ${error.message}`;
        }

        // Reset after 3 seconds
        setTimeout(() => {
            const uploadPrompt = this.fileUploadArea?.querySelector('.upload-prompt');
            if (uploadPrompt) uploadPrompt.style.display = 'flex';
            if (this.uploadProgress) this.uploadProgress.style.display = 'none';
            if (this.progressFill) this.progressFill.style.width = '0%';
            if (this.knowledgeFileInput) this.knowledgeFileInput.value = '';
        }, 3000);
    }

    async extractFileContent(file) {
        const extension = file.name.split('.').pop()?.toLowerCase();
        console.log('Extracting content from file:', file.name, 'extension:', extension, 'type:', file.type, 'size:', file.size);
        
        // For PDF files, we need special handling
        if (extension === 'pdf') {
            return await this.extractPdfContent(file);
        }
        
        // For text-based files, read directly
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                let content = e.target?.result;
                console.log('FileReader loaded, content length:', content?.length);
                
                if (!content) {
                    console.error('FileReader returned empty content');
                    reject(new Error('File appears to be empty'));
                    return;
                }
                
                // Handle JSON files - stringify if needed
                if (extension === 'json') {
                    try {
                        const parsed = JSON.parse(content);
                        content = JSON.stringify(parsed, null, 2);
                    } catch (err) {
                        // Keep as-is if not valid JSON
                        console.log('JSON parse failed, keeping raw content');
                    }
                }
                
                // Handle CSV - convert to readable format
                if (extension === 'csv') {
                    content = this.csvToReadableText(content);
                }
                
                console.log('Final content length:', content?.length);
                resolve(content);
            };
            
            reader.onerror = (e) => {
                console.error('FileReader error:', e);
                reject(new Error('Failed to read file: ' + (reader.error?.message || 'unknown error')));
            };
            
            reader.readAsText(file);
        });
    }

    async extractPdfContent(file) {
        // Check if PDF.js is available
        if (typeof pdfjsLib === 'undefined') {
            // Try to load PDF.js dynamically
            try {
                await this.loadPdfJs();
            } catch (err) {
                // Fall back to uploading raw and letting backend handle it
                return `[PDF Document: ${file.name}]\n\nNote: PDF text extraction not available in browser. Please convert to text format or install PDF.js.`;
            }
        }

        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += `\n--- Page ${i} ---\n${pageText}\n`;
            }
            
            return fullText.trim();
        } catch (error) {
            console.error('PDF extraction error:', error);
            return `[PDF Document: ${file.name}]\n\nError extracting text: ${error.message}`;
        }
    }

    async loadPdfJs() {
        return new Promise((resolve, reject) => {
            if (typeof pdfjsLib !== 'undefined') {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.onload = () => {
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                resolve();
            };
            script.onerror = () => reject(new Error('Failed to load PDF.js'));
            document.head.appendChild(script);
        });
    }

    csvToReadableText(csvContent) {
        const lines = csvContent.split('\n');
        if (lines.length === 0) return csvContent;
        
        const headers = lines[0].split(',').map(h => h.trim());
        let result = `CSV Data with columns: ${headers.join(', ')}\n\n`;
        
        for (let i = 1; i < Math.min(lines.length, 100); i++) { // Limit to 100 rows
            const values = lines[i].split(',');
            result += `Row ${i}:\n`;
            headers.forEach((header, idx) => {
                result += `  ${header}: ${values[idx]?.trim() || ''}\n`;
            });
            result += '\n';
        }
        
        if (lines.length > 100) {
            result += `\n... and ${lines.length - 100} more rows`;
        }
        
        return result;
    }

    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
}

// Initialize the interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VortexDebugInterface();
});