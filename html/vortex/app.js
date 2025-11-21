class VortexDebugInterface {
    constructor() {
        this.token = localStorage.getItem('vortex_token');
        this.user = null;
        this.conversationId = 'debug-' + Date.now();
        
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
                this.user = await response.json();
                this.showChat();
            } else {
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

            if (response.ok) {
                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('vortex_token', this.token);
                this.showChat();
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
        this.loginContainer.style.display = 'none';
        this.chatContainer.style.display = 'block';
        this.userEmail.textContent = this.user.email || this.user.name || 'User';
        this.messageInput.disabled = false;
        this.sendBtn.disabled = false;
        
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

            if (response.ok) {
                this.addMessage('assistant', data.response);
                
                // Update debug info if available
                if (data.debug) {
                    this.updateDebugOutput(data.debug);
                }
            } else {
                this.addMessage('system', `❌ Error: ${data.message || 'Failed to get response'}`);
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
    }

    async debugConversation() {
        if (!this.conversationId) {
            this.debugOutput.textContent = 'Please enter a conversation ID';
            return;
        }

        try {
            const response = await fetch(`/api/v1/vortex/debug/conversation/${this.conversationId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (response.ok) {
                this.debugOutput.textContent = JSON.stringify(data, null, 2);
            } else {
                this.debugOutput.textContent = `Error: ${data.message || 'Debug failed'}`;
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
}

// Initialize the interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VortexDebugInterface();
});