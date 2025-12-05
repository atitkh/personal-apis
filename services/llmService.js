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
  async generateGeminiResponse({ systemPrompt, messages, temperature = 0.7, maxTokens = 1000 }) {
    try {
      // Convert to Gemini's structured conversation format for better context understanding
      const geminiContents = [];
      
      // Add system prompt as first user message with model acknowledgment
      if (systemPrompt) {
        geminiContents.push({
          role: 'user',
          parts: [{ text: systemPrompt }]
        });
        geminiContents.push({
          role: 'model',
          parts: [{ text: 'Understood. I will follow these instructions.' }]
        });
      }
      
      // Convert conversation messages to Gemini format
      for (const msg of messages) {
        if (msg.role === 'user') {
          geminiContents.push({
            role: 'user',
            parts: [{ text: msg.content }]
          });
        } else if (msg.role === 'assistant') {
          geminiContents.push({
            role: 'model',
            parts: [{ text: msg.content }]
          });
        }
        // Skip other roles (like 'system') as Gemini only supports 'user' and 'model'
      }

      const response = await this.client.models.generateContent({
        model: this.model,
        contents: geminiContents,
        config: {
          temperature: temperature,
          maxOutputTokens: maxTokens
        }
      });
      
      // response.text is a property, not a function
      const text = response.text || '';

      return {
        content: text,
        functionCall: null,
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(geminiContents).length / 4),
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: Math.ceil((JSON.stringify(geminiContents).length + text.length) / 4)
        },
        model: this.model
      };
    } catch (error) {
      this.safeLog('error', 'Gemini generation failed', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
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
      think: false, // Disable thinking/reasoning traces
      options: {
        temperature: temperature,
        top_p: 0.9,
        top_k: 40,
        num_predict: maxTokens // Ollama's parameter for max tokens
      }
    });

    return {
      content: response.data.response,
      functionCall: null,
      usage: {
        prompt_tokens: fullPrompt.length / 4, // Rough estimate
        completion_tokens: response.data.response.length / 4,
        total_tokens: (fullPrompt.length + response.data.response.length) / 4
      },
      model: this.model
    };
  }

  /**
   * Generate response using Ollama API with native tool calling
   * Uses /api/chat endpoint with tools parameter
   */
  /**
   * Generate response with tool calling support
   * Supports Ollama and Gemini native tool calling
   */
  async generateWithTools({ systemPrompt, messages, tools = [], temperature = 0.7, maxTokens = 1000 }) {
    if (!this.client) {
      await this.initialize();
    }

    // Route to provider-specific tool calling implementation
    if (this.provider === 'ollama') {
      return this.generateOllamaWithTools({ systemPrompt, messages, tools, temperature, maxTokens });
    } else if (this.provider === 'gemini') {
      return this.generateGeminiWithTools({ systemPrompt, messages, tools, temperature, maxTokens });
    } else {
      // For other providers, fall back to standard generation (no tool support yet)
      this.safeLog('warn', `Tool calling with ${this.provider} provider - falling back to standard generation (tools not supported)`);
      const response = await this.generateResponse({
        systemPrompt,
        messages,
        temperature,
        maxTokens
      });
      return {
        content: response.content,
        toolCalls: [],
        usage: response.usage,
        model: response.model
      };
    }
  }

  /**
   * Generate response using Gemini with native function calling
   */
  async generateGeminiWithTools({ systemPrompt, messages, tools = [], temperature = 0.7, maxTokens = 1000 }) {
    try {
      // Convert tools to Gemini function declarations
      const functionDeclarations = tools.map(tool => {
        // Handle both Ollama format (type: 'function') and raw format
        const func = tool.type === 'function' ? tool.function : tool;
        
        return {
          name: func.name || func.fullName,
          description: func.description || '',
          parametersJsonSchema: func.parameters || func.inputSchema || {
            type: 'object',
            properties: {},
            required: []
          }
        };
      });

      // Convert messages to Gemini's structured format
      const geminiContents = [];
      
      // Add system prompt as first user message
      if (systemPrompt) {
        geminiContents.push({
          role: 'user',
          parts: [{ text: systemPrompt }]
        });
        geminiContents.push({
          role: 'model',
          parts: [{ text: 'Understood. I will follow these instructions.' }]
        });
      }
      
      // Convert each message to Gemini format
      for (const msg of messages) {
        if (msg.role === 'user') {
          geminiContents.push({
            role: 'user',
            parts: [{ text: msg.content }]
          });
        } else if (msg.role === 'assistant' && msg.tool_calls) {
          // Assistant made tool calls - convert to Gemini format
          const parts = msg.tool_calls.map(tc => ({
            functionCall: {
              name: tc.function.name,
              args: tc.function.arguments || {}
            }
          }));
          geminiContents.push({
            role: 'model',
            parts: parts
          });
        } else if (msg.role === 'tool') {
          // Tool result - convert to Gemini function response format
          geminiContents.push({
            role: 'function',
            parts: [{
              functionResponse: {
                name: msg.tool_name,
                response: {
                  content: msg.content
                }
              }
            }]
          });
        } else if (msg.role === 'assistant') {
          geminiContents.push({
            role: 'model',
            parts: [{ text: msg.content }]
          });
        }
      }

      const response = await this.client.models.generateContent({
        model: this.model,
        contents: geminiContents,
        config: {
          temperature: temperature,
          maxOutputTokens: maxTokens,
          tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
        }
      });

      const text = response.text || '';
      const functionCalls = response.functionCalls || [];

      // Convert Gemini function calls to Ollama format for consistency
      const toolCalls = functionCalls.map(fc => ({
        function: {
          name: fc.name,
          arguments: fc.args || {}
        }
      }));

      return {
        content: text,
        toolCalls: toolCalls,
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(geminiContents).length / 4),
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: Math.ceil((JSON.stringify(geminiContents).length + text.length) / 4)
        },
        model: this.model
      };
    } catch (error) {
      this.safeLog('error', 'Gemini tool calling failed', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Generate response using Ollama with native tool calling
   */
  async generateOllamaWithTools({ systemPrompt, messages, tools = [], temperature = 0.7, maxTokens = 1000 }) {
    const axios = require('axios');
    
    if (!this.client) {
      await this.initialize();
    }

    // Format messages for Ollama chat API
    const ollamaMessages = [];
    
    if (systemPrompt) {
      ollamaMessages.push({ role: 'system', content: systemPrompt });
    }
    
    for (const msg of messages) {
      ollamaMessages.push({
        role: msg.role,
        content: msg.content
      });
    }

    // Check if tools are already in Ollama format (have type: 'function' and function property)
    // or need conversion from MCP format
    console.log('\n========== TOOLS INPUT DEBUG ==========');
    console.log('Input tools count:', tools.length);
    if (tools.length > 0) {
      console.log('First tool sample:', JSON.stringify(tools[0], null, 2));
    }
    console.log('========================================\n');
    
    const ollamaTools = tools.map(tool => {
      // Already in Ollama format
      if (tool.type === 'function' && tool.function) {
        return tool;
      }
      // Convert from MCP/raw format
      return {
        type: 'function',
        function: {
          name: tool.fullName || tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: []
          }
        }
      };
    });

    console.log('\n========== OLLAMA TOOL CALL REQUEST ==========');
    console.log('Model:', this.model);
    console.log('Messages:', JSON.stringify(ollamaMessages, null, 2));
    console.log('Tools:', JSON.stringify(ollamaTools, null, 2));
    console.log('===============================================\n');

    const response = await axios.post(`${this.client.baseURL}/api/chat`, {
      model: this.model,
      messages: ollamaMessages,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      stream: false,
    });

    console.log('\n========== OLLAMA TOOL CALL RESPONSE ==========');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    console.log('================================================\n');

    const message = response.data.message;

    return {
      content: message.content || '',
      toolCalls: message.tool_calls || [],
      usage: {
        prompt_tokens: response.data.prompt_eval_count || 0,
        completion_tokens: response.data.eval_count || 0,
        total_tokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0)
      },
      model: response.data.model
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
      memoryPreview: relevantMemories.slice(0, 2).map(m => (m.content || m.document)?.substring(0, 50) + '...')
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
- Just answer the question but never repeat what assistant said last. 
- Don't add filler like "That's a great question!" or "I'd be happy to help!"
- Use what you know from past chats naturally - don't announce that you're remembering things
- Keep it short and real
- Skip the formalities - no need for greetings or sign-offs unless it makes sense
- Don't explain what you're doing ("Let me help you with that..." - just help)
- If you don't know something, just say so casually

CRITICAL - Memory Honesty:
- ONLY reference information that exists in "What you know from past chats" above
- If the user asks about something NOT in your memories, honestly say "I don't recall that" or "I don't have any memory of that"
- NEVER fabricate, invent, or guess details about the user's life, travels, experiences, or preferences
- It's okay to not know things - just be honest about it

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
      knowledge: [],
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

    // Format knowledge base entries (highest priority - full content)
    if (grouped.knowledge.length > 0) {
      const knowledge = grouped.knowledge.map(m => {
        const title = m.metadata?.title || 'Document';
        const content = m.content || m.document || '';
        return `### ${title}\n${content}`;
      }).join('\n\n');
      sections.push(`Reference Knowledge:\n${knowledge}`);
    }

    // Format preferences/facts (most important for context)
    if (grouped.preference.length > 0) {
      const prefs = grouped.preference.map(m => `- ${m.content || m.document}`).join('\n');
      sections.push(`Preferences:\n${prefs}`);
    }

    if (grouped.fact.length > 0) {
      const facts = grouped.fact.map(m => `- ${m.content || m.document}`).join('\n');
      sections.push(`Known facts:\n${facts}`);
    }

    if (grouped.event.length > 0) {
      const events = grouped.event.map(m => {
        const time = new Date(m.metadata?.timestamp).toLocaleDateString();
        return `- [${time}] ${m.content || m.document}`;
      }).join('\n');
      sections.push(`Past events:\n${events}`);
    }

    // Format conversation snippets (less prominent)
    if (grouped.conversation.length > 0) {
      const convos = grouped.conversation.map(m => {
        const time = new Date(m.metadata?.timestamp).toLocaleDateString();
        const role = m.metadata?.role || 'user';
        const text = m.content || m.document || '';
        return `- [${time}] ${role}: "${text.substring(0, 150)}${text.length > 150 ? '...' : ''}"`;
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
4. "action" - Any other specific action to be performed possibly via mcp

USER MESSAGE: "${message}"

Respond with a JSON array of detected actions. Each action should have:
{
  "type": "remember|remind|note|action",
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
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: classificationPrompt
        });
        content = response.text.trim();
        
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
            // Quick test for Gemini - client existence means operational
            status.connectionStatus = 'operational';
            
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

// Export both the singleton instance and the class
const instance = new LLMService();
module.exports = instance;
module.exports.LLMService = LLMService;