const { logger } = require('../utils/logger');

class LLMService {
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
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'openai';
    this.apiKey = process.env.LLM_API_KEY;
    this.model = process.env.LLM_MODEL || this.getDefaultModel();
    this.baseURL = process.env.LLM_BASE_URL; // For Ollama and custom endpoints
    this.client = null;
  }

  /**
   * Get default model based on provider
   */
  getDefaultModel() {
    switch (this.provider) {
      case 'openai': return 'gpt-3.5-turbo';
      case 'anthropic': return 'claude-3-sonnet-20240229';
      case 'gemini': return 'gemini-pro';
      case 'ollama': return 'llama2'; // Or whatever model you have locally
      default: return 'gpt-3.5-turbo';
    }
  }

  /**
   * Initialize LLM client based on provider
   */
  async initialize() {
    try {
      // Check API key requirement (not needed for Ollama)
      if (this.provider !== 'ollama' && !this.apiKey) {
        throw new Error(`LLM_API_KEY environment variable required for ${this.provider}`);
      }

      if (this.provider === 'openai') {
        const { OpenAI } = require('openai');
        this.client = new OpenAI({
          apiKey: this.apiKey
        });
        
      } else if (this.provider === 'anthropic') {
        const { Anthropic } = require('@anthropic-ai/sdk');
        this.client = new Anthropic({
          apiKey: this.apiKey
        });
        
      } else if (this.provider === 'gemini') {
        const { GoogleGenAI } = require('@google/genai');
        this.client = new GoogleGenAI({apiKey: this.apiKey});
        
      } else if (this.provider === 'ollama') {
        // Ollama uses HTTP requests, no special client needed
        this.baseURL = this.baseURL || 'http://localhost:11434';
        this.client = { type: 'ollama', baseURL: this.baseURL };
        
      } else {
        throw new Error(`Unsupported LLM provider: ${this.provider}`);
      }

      this.safeLog('info', `LLMService initialized with ${this.provider} provider (model: ${this.model})`);
    } catch (error) {
      this.safeLog('error', 'LLMService initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate a chat response using the configured LLM
   */
  async generateResponse({ systemPrompt, messages, userId, conversationId, functionCalls = [], temperature = 0.7, maxTokens = 1000 }) {
    try {
      if (!this.client) {
        await this.initialize();
      }

      let response;
      
      if (this.provider === 'openai') {
        response = await this.generateOpenAIResponse({
          systemPrompt,
          messages,
          functionCalls,
          temperature,
          maxTokens
        });
      } else if (this.provider === 'anthropic') {
        response = await this.generateAnthropicResponse({
          systemPrompt,
          messages,
          temperature,
          maxTokens
        });
      } else if (this.provider === 'gemini') {
        response = await this.generateGeminiResponse({
          systemPrompt,
          messages,
          temperature,
          maxTokens
        });
      } else if (this.provider === 'ollama') {
        response = await this.generateOllamaResponse({
          systemPrompt,
          messages,
          temperature,
          maxTokens
        });
      }

      this.safeLog('debug', 'LLM response generated', {
        userId,
        conversationId,
        provider: this.provider,
        model: this.model,
        messageCount: messages.length,
        responseLength: response?.content?.length || 0
      });

      return response;

    } catch (error) {
      this.safeLog('error', 'Failed to generate LLM response', {
        userId,
        conversationId,
        provider: this.provider,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Generate response using OpenAI
   */
  async generateOpenAIResponse({ systemPrompt, messages, functionCalls }) {
    const chatMessages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...messages
    ];

    const requestParams = {
      model: this.model,
      messages: chatMessages,
      temperature: 0.7,
      max_tokens: 2000
    };

    // Add function calling if provided
    if (functionCalls && functionCalls.length > 0) {
      requestParams.functions = functionCalls;
      requestParams.function_call = 'auto';
    }

    const completion = await this.client.chat.completions.create(requestParams);
    
    const message = completion.choices[0].message;
    
    return {
      content: message.content,
      functionCall: message.function_call ? {
        name: message.function_call.name,
        arguments: JSON.parse(message.function_call.arguments || '{}')
      } : null,
      usage: completion.usage,
      model: completion.model
    };
  }

  /**
   * Generate response using Anthropic Claude
   */
  async generateAnthropicResponse({ systemPrompt, messages }) {
    // Convert messages format for Anthropic
    const anthropicMessages = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      temperature: 0.7,
      system: systemPrompt,
      messages: anthropicMessages
    });

    return {
      content: response.content[0].text,
      functionCall: null, // Anthropic doesn't support function calling in the same way
      usage: response.usage,
      model: response.model
    };
  }

  /**
   * Generate response using Google Gemini
   */
  async generateGeminiResponse({ systemPrompt, messages }) {
    
    // Combine system prompt with conversation
    const fullPrompt = `${systemPrompt}\n\nConversation:\n` + 
      messages.map(msg => `${msg.role}: ${msg.content}`).join('\n') + 
      '\nassistant:';

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: `${fullPrompt}`
    });
    
    const text = response.text();

    return {
      content: text,
      functionCall: null, // Gemini function calling would need special handling
      usage: {
        prompt_tokens: fullPrompt.length / 4, // Rough estimate
        completion_tokens: text.length / 4,
        total_tokens: (fullPrompt.length + text.length) / 4
      },
      model: this.model
    };
  }

  /**
   * Generate response using Ollama API
   */
  async generateOllamaResponse({ systemPrompt, messages, temperature = 0.7, maxTokens = 1000 }) {
    const axios = require('axios');
    
    // Build the prompt for Ollama
    const conversation = messages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const fullPrompt = `${systemPrompt}\n\n${conversation}\nassistant:`;

    const response = await axios.post(`${this.client.baseURL}/api/generate`, {
      model: this.model,
      prompt: fullPrompt,
      stream: false,
      options: {
        temperature: temperature,
        top_p: 0.9,
        top_k: 40,
        num_predict: maxTokens // Ollama's parameter for max tokens
      }
    });

    return {
      content: response.data.response,
      functionCall: null, // Ollama models would need custom function calling implementation
      usage: {
        prompt_tokens: fullPrompt.length / 4, // Rough estimate
        completion_tokens: response.data.response.length / 4,
        total_tokens: (fullPrompt.length + response.data.response.length) / 4
      },
      model: this.model
    };
  }

  /**
   * Build system prompt for Vortex
   */
  buildSystemPrompt({ userContext, relevantMemories, currentTime, personality }) {
    const memoryContext = relevantMemories.length > 0 
      ? this.formatMemoryContext(relevantMemories)
      : 'No relevant memories found.';

    // Log what memories are being used in the system prompt
    this.safeLog('debug', 'Building system prompt with memories', {
      memoryCount: relevantMemories.length,
      memoryTypes: relevantMemories.map(m => m.type),
      memoryPreview: relevantMemories.slice(0, 2).map(m => m.content?.substring(0, 50) + '...')
    });

    return `You're Vortex - ${personality.description}.

How you talk:
${personality.traits.map(trait => `- ${trait}`).join('\n')}

Context:
- It's ${currentTime}
- Talking to: ${userContext.name || 'someone'}
${userContext.location ? `- They're in ${userContext.location}` : ''}

What you know from past chats:
${memoryContext}

Rules:
- Just answer the question. Don't add filler like "That's a great question!" or "I'd be happy to help!"
- Use what you know from past chats naturally - don't announce that you're remembering things
- Keep it short and real
- Skip the formalities - no need for greetings or sign-offs unless it makes sense
- Don't explain what you're doing ("Let me help you with that..." - just help)
- If you don't know something, just say so casually
- Match the vibe of how they're talking to you

You're having a normal conversation, not giving a presentation.`;
  }

  /**
   * Format memory context for system prompt
   */
  formatMemoryContext(memories) {
    if (!memories || memories.length === 0) {
      return 'No relevant memories found.';
    }

    // Group memories by type for better organization
    const grouped = {
      preference: [],
      fact: [],
      event: [],
      conversation: []
    };

    memories.forEach(memory => {
      const type = memory.type || memory.metadata?.type || 'conversation';
      if (grouped[type]) {
        grouped[type].push(memory);
      } else {
        grouped.conversation.push(memory);
      }
    });

    const sections = [];

    // Format preferences/facts (most important for context)
    if (grouped.preference.length > 0) {
      const prefs = grouped.preference.map(m => `- ${m.content}`).join('\n');
      sections.push(`Preferences:\n${prefs}`);
    }

    if (grouped.fact.length > 0) {
      const facts = grouped.fact.map(m => `- ${m.content}`).join('\n');
      sections.push(`Known facts:\n${facts}`);
    }

    if (grouped.event.length > 0) {
      const events = grouped.event.map(m => {
        const time = new Date(m.metadata?.timestamp).toLocaleDateString();
        return `- [${time}] ${m.content}`;
      }).join('\n');
      sections.push(`Past events:\n${events}`);
    }

    // Format conversation snippets (less prominent)
    if (grouped.conversation.length > 0) {
      const convos = grouped.conversation.map(m => {
        const time = new Date(m.metadata?.timestamp).toLocaleDateString();
        const role = m.metadata?.role || 'user';
        return `- [${time}] ${role}: "${m.content?.substring(0, 150)}${m.content?.length > 150 ? '...' : ''}"`;
      }).join('\n');
      sections.push(`Related past conversations:\n${convos}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Extract function calls and action commands from user message using LLM classification
   */
  async extractActionCommands(message) {
    try {
      if (!this.client) {
        await this.initialize();
      }

      const classificationPrompt = `Analyze the following user message and determine if it contains any actionable commands that should be executed by an AI assistant.

IMPORTANT: Only detect actions when the user is giving instructions or making explicit requests to store/retrieve information. Questions ABOUT memory or past conversations should NOT be classified as actions.

AVAILABLE ACTIONS:
1. "remember" - Store information for future reference
2. "remind" - Set a reminder or note for later  
3. "note" - Save a general note or observation

USER MESSAGE: "${message}"

Respond with a JSON array of detected actions. Each action should have:
{
  "type": "remember|remind|note",
  "content": "the specific content to act on",
  "confidence": 0.0-1.0
}

If no actions are detected, respond with an empty array [].

Examples:
- "Remember that I prefer TypeScript" → [{"type": "remember", "content": "I prefer TypeScript", "confidence": 0.9}]
- "Remind me to call mom tomorrow" → [{"type": "remind", "content": "call mom tomorrow", "confidence": 0.9}]
- "Note that the deployment was successful" → [{"type": "note", "content": "the deployment was successful", "confidence": 0.8}]
- "What did I ask you to remember?" → [] (this is a QUESTION, not an action)
- "Can you tell me what we talked about before?" → [] (this is a QUESTION, not an action)
- "What's the weather like?" → []

Respond with only the JSON array, no other text.`;

      let content;
      
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: classificationPrompt }],
          temperature: 0.1, // Low temperature for consistent classification
          max_tokens: 200
        });
        content = response.choices[0].message.content.trim();
        
      } else if (this.provider === 'anthropic') {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 200,
          temperature: 0.1,
          messages: [{ role: 'user', content: classificationPrompt }]
        });
        content = response.content[0].text.trim();
        
      } else if (this.provider === 'gemini') {
        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(classificationPrompt);
        const response = await result.response;
        content = response.text().trim();
        
      } else if (this.provider === 'ollama') {
        const axios = require('axios');
        const response = await axios.post(`${this.client.baseURL}/api/generate`, {
          model: this.model,
          prompt: classificationPrompt,
          stream: false,
          options: {
            temperature: 0.1,
            top_p: 0.9
          }
        });
        content = response.data.response.trim();
        
      } else {
        return [];
      }

      // Parse the JSON response
      return JSON.parse(content);

    } catch (error) {
      this.safeLog('error', 'Action classification failed', { error: error.message, message });
      // Fallback to empty array on error to prevent breaking chat
      return [];
    }
  }

  /**
   * Get available function definitions for OpenAI function calling  
   */
  getFunctionDefinitions() {
    return [
      {
        name: 'remember_information',
        description: 'Store important information for future reference',
        parameters: {
          type: 'object',
          properties: {
            information: {
              type: 'string',
              description: 'The information to remember'
            },
            category: {
              type: 'string',
              description: 'Category or type of information (preference, fact, instruction, etc.)'
            }
          },
          required: ['information']
        }
      },
      {
        name: 'search_memories',
        description: 'Search through previous conversations and memories',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What to search for in memories'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'set_reminder',
        description: 'Set a reminder or note for the user',
        parameters: {
          type: 'object',
          properties: {
            reminder: {
              type: 'string', 
              description: 'The reminder content'
            },
            when: {
              type: 'string',
              description: 'When to remind (optional time/date)'
            }
          },
          required: ['reminder']
        }
      }
    ];
  }

  /**
   * Get service status
   */
  async getStatus() {
    try {
      const status = {
        provider: this.provider,
        model: this.model,
        initialized: !!this.client,
        hasApiKey: !!this.apiKey
      };

      // Test connection if initialized
      if (this.client) {
        try {
          if (this.provider === 'openai') {
            // Simple test call
            await this.client.chat.completions.create({
              model: this.model,
              messages: [{ role: 'user', content: 'test' }],
              max_tokens: 1
            });
            status.connectionStatus = 'operational';
            
          } else if (this.provider === 'anthropic') {
            // Test Anthropic connection
            status.connectionStatus = 'operational'; // Assume operational if client exists
            
          } else if (this.provider === 'gemini') {
            // Quick test for Gemini
            const model = this.client.getGenerativeModel({ model: this.model });
            status.connectionStatus = 'operational'; // Assume operational if client exists
            
          } else if (this.provider === 'ollama') {
            // Test Ollama connection
            const axios = require('axios');
            await axios.get(`${this.client.baseURL}/api/tags`);
            status.connectionStatus = 'operational';
            status.ollamaURL = this.client.baseURL;
            
          } else {
            status.connectionStatus = 'unknown_provider';
          }
        } catch (error) {
          status.connectionStatus = 'error';
          status.connectionError = error.message;
        }
      } else {
        status.connectionStatus = 'not_initialized';
      }

      return status;

    } catch (error) {
      return {
        provider: this.provider,
        status: 'error',
        error: error.message
      };
    }
  }
}

module.exports = new LLMService();