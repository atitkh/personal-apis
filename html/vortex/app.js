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
        this.conversationIdInput.addEventListener('change', (e) => {
            this.conversationId = e.target.value;
        });
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

    addMessage(role, content) {
        console.log('Adding message:', role, content);
        
        if (!this.chatMessages) {
            console.error('chatMessages element not found!');
            return;
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.textContent = content;
        messageDiv.appendChild(contentDiv);
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        messageDiv.appendChild(timeDiv);
        
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        
        console.log('Message added, total messages now:', this.chatMessages.children.length);
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
}

// Initialize the interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VortexDebugInterface();
});