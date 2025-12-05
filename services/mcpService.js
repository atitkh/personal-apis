/**
 * MCP (Model Context Protocol) Service
 * 
 * Handles tool discovery, intent classification, and tool execution
 * for Vortex AI. Supports MCP servers, HTTP APIs, and internal modules.
 * 
 * @module services/mcpService
 */

const { spawn } = require('child_process');
const { logger } = require('../utils/logger');
const path = require('path');
const fs = require('fs');

class MCPService {
  constructor() {
    this.config = null;
    this.servers = new Map();           // Active server connections
    this.toolRegistry = new Map();      // All discovered tools: toolName -> { server, tool }
    this.isInitialized = false;
    this.llmService = null;             // Main LLM (fallback)
    this.mcpLLMService = null;          // Dedicated MCP LLM for tool calling
    this.memoryService = null;          // For storing actions
    
    // Enhanced service configuration defaults
    this.defaultSettings = {
      enabled: true,
      maxRetries: 2,
      maxPasses: 4,                     // Multi-pass execution limit
      maxToolCallsPerMessage: 8,        // Increased for complex scenarios
      toolExecutionTimeout: 45000,      // Increased timeout for chained operations
      enableIntelligentChaining: true,  // Enable multi-pass tool chaining
      enableParallelExecution: true,    // Parallel tool execution
      storeActionsInMemory: true,
      maxChainDepth: 5,                 // Maximum tool chain depth
      analysisTimeout: 15000,           // Timeout for result analysis
    };
  }

  /**
   * Resolve environment variables in a string or object
   * Supports ${VAR_NAME} syntax
   */
  resolveEnvVars(value) {
    if (typeof value === 'string') {
      return value.replace(/\$\{(\w+)\}/g, (match, varName) => {
        return process.env[varName] || match;
      });
    }
    if (Array.isArray(value)) {
      return value.map(v => this.resolveEnvVars(v));
    }
    if (typeof value === 'object' && value !== null) {
      const resolved = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = this.resolveEnvVars(v);
      }
      return resolved;
    }
    return value;
  }

  /**
   * Validate MCP service configuration and provide helpful diagnostics
   */
  validateConfiguration() {
    const issues = [];
    const warnings = [];
    
    if (!this.config) {
      issues.push('No MCP configuration found');
      return { isValid: false, issues, warnings };
    }

    // Check settings
    const settings = { ...this.defaultSettings, ...(this.config.settings || {}) };
    
    if (!settings.enabled) {
      warnings.push('MCP service is disabled in configuration');
    }
    
    if (settings.maxRetries < 0 || settings.maxRetries > 5) {
      warnings.push(`maxRetries (${settings.maxRetries}) should be between 0-5`);
    }
    
    if (settings.maxPasses < 1 || settings.maxPasses > 10) {
      warnings.push(`maxPasses (${settings.maxPasses}) should be between 1-10`);
    }
    
    if (settings.toolExecutionTimeout < 5000 || settings.toolExecutionTimeout > 300000) {
      warnings.push(`toolExecutionTimeout (${settings.toolExecutionTimeout}ms) should be between 5-300 seconds`);
    }

    // Check servers configuration
    if (!this.config.servers || this.config.servers.length === 0) {
      issues.push('No MCP servers configured');
    } else {
      const enabledServers = this.config.servers.filter(s => s.enabled !== false);
      if (enabledServers.length === 0) {
        warnings.push('All MCP servers are disabled');
      }
      
      // Validate each server
      enabledServers.forEach((server, i) => {
        if (!server.name) {
          issues.push(`Server ${i} missing name`);
        }
        if (!server.type) {
          issues.push(`Server ${i} (${server.name}) missing type`);
        }
        if (server.type === 'mcp-proxy' && !server.command) {
          issues.push(`MCP-proxy server ${server.name} missing command`);
        }
      });
    }

    return {
      isValid: issues.length === 0,
      issues,
      warnings,
      settings
    };
  }

  /**
   * Initialize the MCP service with enhanced validation and diagnostics
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      // Load configuration
      const configPath = path.join(__dirname, '../config/mcp-servers.json');
      
      if (!fs.existsSync(configPath)) {
        logger.warn('MCP config not found, creating default', { configPath });
        this.config = { 
          version: '1.0', 
          settings: { ...this.defaultSettings, enabled: false }, 
          servers: [] 
        };
      } else {
        const configContent = fs.readFileSync(configPath, 'utf8');
        this.config = JSON.parse(configContent);
      }

      // Merge with default settings
      this.config.settings = { ...this.defaultSettings, ...(this.config.settings || {}) };

      // Validate configuration
      const validation = this.validateConfiguration();
      
      if (validation.issues.length > 0) {
        logger.error('MCP configuration issues', { issues: validation.issues });
        // Continue with limited functionality
      }
      
      if (validation.warnings.length > 0) {
        logger.warn('MCP configuration warnings', { warnings: validation.warnings });
      }

      logger.info('MCP configuration validated', {
        enabled: this.config.settings.enabled,
        serversConfigured: this.config.servers?.length || 0,
        serversEnabled: (this.config.servers || []).filter(s => s.enabled !== false).length,
        settings: {
          maxRetries: this.config.settings.maxRetries,
          maxPasses: this.config.settings.maxPasses,
          maxToolCallsPerMessage: this.config.settings.maxToolCallsPerMessage,
          intelligentChaining: this.config.settings.enableIntelligentChaining,
          parallelExecution: this.config.settings.enableParallelExecution
        }
      });

      // Check if MCP is enabled
      if (!this.config.settings?.enabled) {
        logger.info('MCP service is disabled in configuration');
        this.isInitialized = true;
        return;
      }

      // Connect to enabled servers
      for (const serverConfig of this.config.servers || []) {
        if (serverConfig.enabled !== false) {
          try {
            await this.connectServer(serverConfig);
          } catch (error) {
            logger.error('Failed to connect MCP server', { 
              server: serverConfig.name, 
              error: error.message 
            });
            // Continue with other servers
          }
        }
      }

      this.isInitialized = true;
      logger.info('MCP service initialized', {
        serversConnected: this.servers.size,
        toolsDiscovered: this.toolRegistry.size
      });

    } catch (error) {
      logger.error('MCP service initialization failed', { error: error.message });
      this.isInitialized = true; // Mark as initialized to prevent repeated failures
    }
  }

  /**
   * Get LLM service for MCP tool calling
   * Uses dedicated MCP_LLM_* env vars if set, otherwise falls back to main LLM
   */
  getLLMService() {
    // Check if we have dedicated MCP LLM settings
    const mcpProvider = process.env.MCP_LLM_PROVIDER;
    const mcpModel = process.env.MCP_LLM_MODEL;
    
    if (mcpProvider || mcpModel) {
      // Use dedicated MCP LLM
      if (!this.mcpLLMService) {
        // Import the LLMService class and create a new instance
        const { LLMService } = require('./llmService');
        this.mcpLLMService = new LLMService();
        
        // Override with MCP-specific settings
        if (mcpProvider) this.mcpLLMService.provider = mcpProvider;
        if (mcpModel) this.mcpLLMService.model = mcpModel;
        if (process.env.MCP_LLM_BASE_URL) this.mcpLLMService.baseURL = process.env.MCP_LLM_BASE_URL;
        if (process.env.MCP_LLM_API_KEY) this.mcpLLMService.apiKey = process.env.MCP_LLM_API_KEY;
        
        // Re-initialize with new settings
        this.mcpLLMService.client = null;
        
        logger.info('MCP using dedicated LLM', { 
          provider: this.mcpLLMService.provider, 
          model: this.mcpLLMService.model,
          hasApiKey: !!this.mcpLLMService.apiKey,
          apiKeyLength: this.mcpLLMService.apiKey ? this.mcpLLMService.apiKey.length : 0
        });
      }
      return this.mcpLLMService;
    }
    
    // Fall back to main LLM service
    if (!this.llmService) {
      this.llmService = require('./llmService');
    }
    return this.llmService;
  }

  /**
   * Get Memory service (lazy load)
   */
  getMemoryService() {
    if (!this.memoryService) {
      this.memoryService = require('./memoryService');
    }
    return this.memoryService;
  }

  /**
   * Connect to an MCP server and discover its tools
   */
  async connectServer(serverConfig) {
    const { name, type, category } = serverConfig;

    logger.debug('Connecting to MCP server', { name, type, category });

    let serverInstance;

    switch (type) {
      case 'mcp':
        serverInstance = await this.connectMCPServer(serverConfig);
        break;
      case 'http':
        serverInstance = await this.connectHTTPServer(serverConfig);
        break;
      case 'internal':
        serverInstance = await this.connectInternalModule(serverConfig);
        break;
      default:
        throw new Error(`Unknown server type: ${type}`);
    }

    if (serverInstance) {
      this.servers.set(name, {
        config: serverConfig,
        instance: serverInstance,
        tools: serverInstance.tools || []
      });

      // Register tools in global registry
      for (const tool of serverInstance.tools || []) {
        const fullToolName = `${name}.${tool.name}`;
        this.toolRegistry.set(fullToolName, {
          server: name,
          category,
          tool
        });
        
        // Log tool details for debugging
        console.log(`  📦 Registered tool: ${fullToolName}`);
        console.log(`     Description: ${tool.description || 'N/A'}`);
        console.log(`     Schema: ${JSON.stringify(tool.inputSchema || {})}`);
      }

      logger.info('MCP server connected', { 
        name, 
        type, 
        toolCount: serverInstance.tools?.length || 0 
      });
    }
  }

  /**
   * Connect to a stdio-based MCP server
   */
  async connectMCPServer(serverConfig) {
    const { name, command, args = [], env = {} } = serverConfig;

    // Resolve environment variables in command, args, and env
    const resolvedCommand = this.resolveEnvVars(command);
    const resolvedArgs = this.resolveEnvVars(args);
    const resolvedEnv = this.resolveEnvVars(env);

    logger.info('Starting MCP server', { 
      name, 
      command: resolvedCommand, 
      args: resolvedArgs 
    });

    try {
      // Spawn the MCP server process
      const serverProcess = spawn(resolvedCommand, resolvedArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...resolvedEnv },
        shell: true  // Use shell to handle npx properly on Windows
      });

      // Create a simple JSON-RPC client over stdio
      const client = {
        process: serverProcess,
        requestId: 0,
        pendingRequests: new Map(),
        tools: [],
        
        // Send JSON-RPC request
        async request(method, params = {}) {
          return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const request = {
              jsonrpc: '2.0',
              id,
              method,
              params
            };
            
            this.pendingRequests.set(id, { resolve, reject });
            
            serverProcess.stdin.write(JSON.stringify(request) + '\n');
            
            // Timeout after 30 seconds
            setTimeout(() => {
              if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                reject(new Error('MCP request timeout'));
              }
            }, 30000);
          });
        }
      };

      // Handle responses from the server
      let buffer = '';
      serverProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line);
            if (response.id && client.pendingRequests.has(response.id)) {
              const { resolve, reject } = client.pendingRequests.get(response.id);
              client.pendingRequests.delete(response.id);
              
              if (response.error) {
                reject(new Error(response.error.message || 'MCP error'));
              } else {
                resolve(response.result);
              }
            }
          } catch (e) {
            logger.debug('Failed to parse MCP response', { line, error: e.message });
          }
        }
      });

      serverProcess.stderr.on('data', (data) => {
        logger.debug('MCP server stderr', { server: name, data: data.toString() });
      });

      serverProcess.on('error', (error) => {
        logger.error('MCP server process error', { server: name, error: error.message });
      });

      serverProcess.on('exit', (code) => {
        logger.info('MCP server process exited', { server: name, code });
      });

      // Initialize the MCP connection
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vortex-ai', version: '1.0.0' }
      });

      // Discover tools
      const toolsResult = await client.request('tools/list', {});
      client.tools = toolsResult.tools || [];

      logger.info('MCP server connected', { 
        server: name, 
        toolCount: client.tools.length,
        tools: client.tools.map(t => t.name)
      });

      return {
        type: 'mcp',
        client,
        connected: true,
        tools: client.tools,
        call: async (toolName, toolArgs) => {
          const result = await client.request('tools/call', {
            name: toolName,
            arguments: toolArgs
          });
          return result;
        }
      };

    } catch (error) {
      logger.error('Failed to connect MCP server', { 
        server: name, 
        command,
        error: error.message 
      });
      return {
        type: 'mcp',
        connected: false,
        tools: [],
        error: error.message,
        call: async () => {
          throw new Error(`MCP server ${name} not connected: ${error.message}`);
        }
      };
    }
  }

  /**
   * Connect to an HTTP-based tool server
   */
  async connectHTTPServer(serverConfig) {
    const { endpoint, auth, tools = [] } = serverConfig;

    return {
      type: 'http',
      endpoint,
      connected: true,
      tools,
      call: async (toolName, args) => {
        const axios = require('axios');
        
        // Build auth headers
        const headers = {};
        if (auth?.type === 'bearer' && auth.envVar) {
          headers['Authorization'] = `Bearer ${process.env[auth.envVar]}`;
        } else if (auth?.type === 'api_key' && auth.envVar) {
          headers['X-API-Key'] = process.env[auth.envVar];
        }

        const response = await axios.post(`${endpoint}/${toolName}`, args, { headers });
        return response.data;
      }
    };
  }

  /**
   * Connect to an internal module
   */
  async connectInternalModule(serverConfig) {
    const { module: modulePath, tools = [] } = serverConfig;

    try {
      const absolutePath = path.resolve(__dirname, '..', modulePath);
      const moduleInstance = require(absolutePath);

      // If module exports getTools(), use that for dynamic discovery
      let discoveredTools = tools;
      if (typeof moduleInstance.getTools === 'function') {
        discoveredTools = await moduleInstance.getTools();
      }

      return {
        type: 'internal',
        module: moduleInstance,
        connected: true,
        tools: discoveredTools,
        call: async (toolName, args) => {
          // Try executeTool first (standard adapter interface)
          if (typeof moduleInstance.executeTool === 'function') {
            return await moduleInstance.executeTool(toolName, args);
          }
          // Fall back to direct function call
          if (typeof moduleInstance[toolName] === 'function') {
            return await moduleInstance[toolName](args);
          }
          // Fall back to generic execute
          if (typeof moduleInstance.execute === 'function') {
            return await moduleInstance.execute(toolName, args);
          }
          throw new Error(`Tool ${toolName} not found in module`);
        }
      };
    } catch (error) {
      logger.error('Failed to load internal module', { 
        module: modulePath, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * MAIN ENTRY POINT: Process a message for potential tool usage
   * Single-pass approach with retry: LLM sees ALL tools, executes, and can retry on failure
   * Called from vortexService
   */
  async processMessage({ message, userId, conversationId, context = {}, recentMessages = [] }) {
    await this.initialize();

    // Check if MCP is enabled and has tools
    if (!this.config?.settings?.enabled) {
      return { 
        needsTools: false, 
        reason: 'MCP disabled in config',
        configEnabled: false
      };
    }
    
    if (this.toolRegistry.size === 0) {
      return { 
        needsTools: false, 
        reason: 'No tools available (no servers enabled or connected)',
        configEnabled: true,
        serversConfigured: this.config?.servers?.length || 0,
        serversEnabled: (this.config?.servers || []).filter(s => s.enabled !== false).length
      };
    }

    try {
      // Get ALL available tools
      const allTools = this.getAllTools();
      
      console.log('\n========== MCP PROCESS MESSAGE ==========');
      console.log('Tool Registry Size:', this.toolRegistry.size);
      console.log('All Tools Count:', allTools.length);
      if (allTools.length > 0) {
        console.log('Available Tools:', allTools.map(t => t.fullName).join(', '));
      } else {
        console.log('⚠️ NO TOOLS AVAILABLE');
        console.log('Servers connected:', this.servers.size);
        for (const [name, server] of this.servers) {
          console.log(`  - ${name}: ${server.tools?.length || 0} tools`);
        }
      }
      console.log('==========================================\n');
      
      logger.debug('Processing message with all tools', { 
        message: message.substring(0, 50),
        toolCount: allTools.length 
      });

      // Use native Ollama tool-calling conversation loop
      // This lets the LLM handle all the intelligence - we just execute what it asks
      const maxIterations = this.config.settings?.maxPasses || 5;
      let allResults = [];
      let conversationMessages = [];
      let finalLLMResponse = null;
      
      // Build initial user message with context
      let userMessage = message;
      if (recentMessages.length > 0) {
        const contextSummary = recentMessages
          .map(m => `${m.role}: ${m.content}`)
          .join('\n');
        userMessage = `CONVERSATION CONTEXT (for understanding references like "it", "that", etc.):\n${contextSummary}\n\nCURRENT REQUEST: ${message}`;
      }
      
      conversationMessages.push({ role: 'user', content: userMessage });

      // Iterative tool-calling loop - let the LLM drive everything
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        console.log(`\n🔄 TOOL ITERATION ${iteration}/${maxIterations}`);
        
        // Ask LLM what tools to call (if any)
        const response = await this.callLLMWithTools(conversationMessages, allTools);
        
        // If no tool calls, we're done - capture the final response
        if (!response.toolCalls || response.toolCalls.length === 0) {
          console.log(`✅ Iteration ${iteration}: LLM completed (no more tool calls needed)`);
          finalLLMResponse = response.content;
          
          // If this is the first iteration and no tools, user doesn't need tools
          if (iteration === 1) {
            return { 
              needsTools: false,
              reason: 'LLM determined no tools needed for this message',
              llmResponse: response.content
            };
          }
          break; // Exit loop - LLM is done
        }

        // Execute the requested tool calls
        const toolCalls = response.toolCalls.map(tc => ({
          tool: tc.function.name,
          arguments: tc.function.arguments || {}
        }));

        console.log(`🔧 LLM requested ${toolCalls.length} tool(s):`);
        toolCalls.forEach((tc, i) => console.log(`  [${i + 1}] ${tc.tool}`));

        // Execute tools in parallel
        const results = await this.executeToolCalls(toolCalls, { userId, conversationId, context });
        allResults.push(...results);

        // Log results
        console.log(`\n========== ITERATION ${iteration} RESULTS ==========`);
        results.forEach((r, i) => {
          const status = r.success ? '✅' : '❌';
          const resultStr = r.success 
            ? JSON.stringify(r.result).substring(0, 200) 
            : r.error;
          console.log(`  [${i + 1}] ${status} ${r.tool}: ${resultStr}`);
        });
        console.log(`====================================================\n`);

        // Add assistant's tool call to conversation
        conversationMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: response.toolCalls
        });

        // Add tool results to conversation (as per Ollama's format)
        for (const result of results) {
          const resultContent = result.success 
            ? (result.result?.content?.[0]?.text || JSON.stringify(result.result))
            : `Error: ${result.error}`;
          
          conversationMessages.push({
            role: 'tool',
            content: resultContent,
            tool_name: result.tool
          });
        }

        // Continue loop - LLM will see results and decide if more tools needed
      }

      if (allResults.length === 0) {
        return { 
          needsTools: false,
          reason: 'No tools were executed'
        };
      }

      // Return results
      const successfulResults = allResults.filter(r => r.success && !r.result?.isError);
      const failedResults = allResults.filter(r => !r.success || r.result?.isError);
      
      console.log(`\n🎯 FINAL EXECUTION SUMMARY:`);
      console.log(`  Total Results: ${allResults.length}`);
      console.log(`  Successful: ${successfulResults.length}`);
      console.log(`  Failed: ${failedResults.length}`);
      console.log(`  Tools Used: ${[...new Set(allResults.map(r => r.tool))].join(', ')}`);
      console.log(`  LLM Summary: ${finalLLMResponse ? finalLLMResponse.substring(0, 100) + '...' : 'No summary generated'}`);

      return {
        needsTools: true,
        toolsUsed: [...new Set(allResults.map(r => r.tool))],
        toolResults: allResults,
        llmSummary: finalLLMResponse, // The LLM's natural language summary of what happened
        contextForLLM: finalLLMResponse || this.formatResultsForLLM(allResults), // Prefer LLM summary, fallback to raw format
        executionStats: {
          totalResults: allResults.length,
          successful: successfulResults.length,
          failed: failedResults.length
        }
      };
    } catch (error) {
      logger.error('MCP processMessage failed', { error: error.message });
      return { needsTools: false, error: error.message };
    }
  }

  /**
   * Call LLM with tools using native Ollama tool calling
   */
  async callLLMWithTools(messages, availableTools) {
    const llm = this.getLLMService();

    const systemPrompt = `You are an intelligent assistant that uses tools to help users.

RULES:
- Use tools when the user asks you to perform actions or get information
- You can call multiple tools if needed to complete a task
- After seeing tool results, READ and PARSE the data carefully
- Once you have all the information, provide a clear, natural language summary
- Extract specific values, numbers, and states from the tool results
- Don't say "I retrieved..." or "The tool returned..." - just answer naturally

IMPORTANT: When you're done calling tools, you MUST:
1. READ the tool results thoroughly
2. EXTRACT the relevant information (numbers, states, values, success/failure status)
3. For QUERIES (temperature, status, etc): Answer with the information found
4. For ACTIONS (turn on, set, control, etc): Confirm the action was completed successfully or report if it failed
5. Provide a natural, conversational response

Examples:
- Query: "What's the temperature?" → "The bedroom temperature is 30.1°C"
- Action: "Turn on the lights" → "The lights are now on" (if successful)
- Failed action: "Turn on the lights" → "I tried to turn on the lights but encountered an error: [error details]"

For casual conversation, don't use tools.`;


    // Convert tools to Ollama format
    const ollamaTools = availableTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.fullName,
        description: tool.description || '',
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    }));

    try {
      const response = await llm.generateWithTools({
        systemPrompt,
        messages,
        tools: ollamaTools,
        temperature: 0.1,
        maxTokens: 1000
      });

      return {
        content: response.content,
        toolCalls: response.toolCalls || []
      };
    } catch (error) {
      logger.error('callLLMWithTools failed', { error: error.message });
      return { content: '', toolCalls: [] };
    }
  }

  /**
   * Format results for the main conversation LLM
   */
  formatResultsForLLM(results) {
    if (!results || results.length === 0) {
      return 'No tool results available.';
    }

    const successful = results.filter(r => r.success && !r.result?.isError);
    const failed = results.filter(r => !r.success || r.result?.isError);

    let formatted = '';

    if (successful.length > 0) {
      formatted += 'COMPLETED ACTIONS:\n';
      successful.forEach((r, i) => {
        const resultText = r.result?.content?.[0]?.text || JSON.stringify(r.result);
        formatted += `${i + 1}. ${r.tool}: ${resultText}\n`;
      });
    }

    if (failed.length > 0) {
      formatted += '\nFAILED ACTIONS:\n';
      failed.forEach((r, i) => {
        const error = r.error || r.result?.content?.[0]?.text || 'Unknown error';
        formatted += `${i + 1}. ${r.tool}: ${error}\n`;
      });
    }

    return formatted.trim();
  }

  /**
   * Get all available tools
   */
  getAllTools() {
    const tools = [];
    for (const [fullName, info] of this.toolRegistry) {
      tools.push({
        fullName,
        server: info.server,
        category: info.category,
        name: info.tool.name,
        description: info.tool.description,
        inputSchema: info.tool.inputSchema
      });
    }
    return tools;
  }

  /**
   * Use Ollama's native tool calling API
   */
  async selectToolsWithOllamaNative(message, availableTools, conversationHistory = [], recentContext = []) {
    const llm = this.getLLMService();

    // Simple, generic system prompt - let the LLM be intelligent
    const systemPrompt = `You are a tool-calling assistant. When the user asks you to perform actions or get information, use the available tools appropriately.

RULES:
- Analyze what the user wants and pick the right tools
- You can call multiple tools if the request requires it
- Use context from conversation to understand references like "it", "that", etc.
- For casual conversation, don't use tools
- Extract parameter values exactly as mentioned`;

    // Build user message with context
    let userMessage = message;
    if (recentContext.length > 0) {
      const contextSummary = recentContext
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');
      
      userMessage = `CONTEXT:\n${contextSummary}\n\nCURRENT: ${message}`;
    }

    const messages = [{ role: 'user', content: userMessage }];

    // Add retry context if any
    for (const historyMsg of conversationHistory) {
      messages.push(historyMsg);
    }

    try {
      const response = await llm.generateOllamaWithTools({
        systemPrompt,
        messages,
        tools: availableTools,
        temperature: 0.1,
        maxTokens: 1000
      });

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCalls = response.toolCalls.map(tc => ({
          tool: tc.function.name,
          arguments: tc.function.arguments || {}
        }));

        console.log(`\nOllama returned ${toolCalls.length} tool call(s):`);
        toolCalls.forEach((call, i) => {
          console.log(`  [${i + 1}] ${call.tool} with args: ${JSON.stringify(call.arguments)}`);
        });

        const maxCalls = this.config.settings?.maxToolCallsPerMessage || 10;
        return toolCalls
          .filter(call => call.tool && this.toolRegistry.has(call.tool))
          .slice(0, maxCalls);
      }

      // Check for JSON in content as fallback
      if (response.content) {
        try {
          const jsonMatch = response.content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const maxCalls = this.config.settings?.maxToolCallsPerMessage || 10;
              return parsed
                .filter(call => call.tool && this.toolRegistry.has(call.tool))
                .slice(0, maxCalls);
            }
          }
        } catch (e) {
          // Not valid JSON, that's fine
        }
      }

      return [];
    } catch (error) {
      logger.error('selectToolsWithOllamaNative failed', { error: error.message });
      return [];
    }
  }

  /**
   * Fallback: Use prompt-based tool selection (for non-Ollama providers)
   */
  async selectToolsWithPrompt(message, availableTools, conversationHistory = [], recentContext = []) {
    const llm = this.getLLMService();

    // Build context summary for pronoun resolution
    let contextNote = '';
    if (recentContext.length > 0) {
      const contextSummary = recentContext
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');
      contextNote = `\nRECENT CONVERSATION (for understanding references like "it", "that" - DO NOT re-execute these):\n${contextSummary}\n`;
    }

    // Build compact tool descriptions
    const toolsDescription = availableTools.map(t => {
      let params = '';
      if (t.inputSchema?.properties) {
        const required = t.inputSchema.required || [];
        const paramList = Object.entries(t.inputSchema.properties)
          .map(([name, info]) => {
            const req = required.includes(name) ? '*' : '';
            const desc = info.description ? ` - ${info.description}` : '';
            return `${name}${req}: ${info.type}${desc}`;
          })
          .join(', ');
        params = ` (${paramList})`;
      }
      return `• ${t.fullName}${params}\n  ${t.description}`;
    }).join('\n');

    const systemPrompt = 'You are a precise tool-calling assistant. Output ONLY valid JSON array. No explanations.';

    const initialPrompt = `You are a tool-calling assistant. Analyze the user's CURRENT message and determine if any tools should be called.
${contextNote}
USER MESSAGE (act on THIS only): "${message}"

AVAILABLE TOOLS (* = required parameter):
${toolsDescription}

INSTRUCTIONS:
1. Only act on the CURRENT USER MESSAGE above, not past messages in context
2. Use context only to understand references like "it", "that", "the light"
3. If the message is casual conversation (greetings, chitchat, questions not requiring action), return []
4. If the message requires action, select the appropriate tool(s)
5. Extract parameter values from the user's message - use the exact names/values they mention
6. Never use null for required parameters - infer reasonable values from context
7. Match tool names exactly as shown above (including the server prefix)

RESPONSE FORMAT (JSON array only, no other text):
[{"tool": "server.ToolName", "arguments": {"param": "value"}}]

Return [] if no tools are needed.`;

    // Build messages array with history for retries
    const messages = [
      { role: 'user', content: initialPrompt },
      ...conversationHistory
    ];

    // Debug: Print exactly what goes into the LLM
    console.log('\n========== MCP LLM INPUT (Prompt-based) ==========');
    console.log('SYSTEM PROMPT:\n', systemPrompt);
    console.log('\nUSER MESSAGE (includes tools):');
    console.log(initialPrompt);
    if (conversationHistory.length > 0) {
      console.log('\nCONVERSATION HISTORY:');
      conversationHistory.forEach((msg, i) => {
        console.log(`[${i}] ${msg.role}:`, msg.content);
      });
    }
    console.log('===================================================\n');

    try {
      const response = await llm.generateResponse({
        systemPrompt,
        messages,
        temperature: 0.1,
        maxTokens: 500
      });

      // Log what came out of the LLM
      console.log('\n========== MCP LLM RESPONSE ==========');
      console.log(`Raw Response: ${response.content}`);
      console.log('=======================================\n');

      // Parse JSON from response
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const calls = JSON.parse(jsonMatch[0]);
        
        console.log(`Parsed ${calls.length} tool call(s):`);
        calls.forEach((call, i) => {
          console.log(`  [${i + 1}] ${call.tool} with args: ${JSON.stringify(call.arguments)}`);
        });
        
        // Validate and limit calls
        const maxCalls = this.config.settings?.maxToolCallsPerMessage || 5;
        const validCalls = calls
          .filter(call => {
            if (!call.tool || !this.toolRegistry.has(call.tool)) {
              logger.warn('Invalid tool call filtered out', { tool: call.tool });
              return false;
            }
            return true;
          })
          .slice(0, maxCalls);

        return validCalls;
      } else {
        console.log('No JSON array found in response');
      }
    } catch (error) {
      logger.error('Tool selection failed', { error: error.message });
    }

    return [];
  }

  /**
   * Execute multiple tool calls in parallel for better performance
   */
  async executeToolCalls(toolCalls, { userId, conversationId, context }) {
    // Execute all tool calls in parallel
    const promises = toolCalls.map(async (call) => {
      try {
        logger.info('Executing tool call', { 
          tool: call.tool, 
          arguments: call.arguments
        });

        const result = await this.executeToolCall(call);
        
        // Check if the MCP response indicates an error
        const isError = result?.isError === true || 
          (result?.content?.[0]?.text?.toLowerCase().includes('error'));
        
        if (isError) {
          // Tool executed but returned an error response
          const resultObj = {
            tool: call.tool,
            arguments: call.arguments,
            success: false,
            result,
            error: result?.content?.[0]?.text || 'Tool returned error'
          };
          return resultObj;
        } else {
          const resultObj = {
            tool: call.tool,
            arguments: call.arguments,
            success: true,
            result
          };

          // Store action in memory if enabled (only for successes)
          // Note: Memory storage remains sequential to avoid race conditions
          if (this.config.settings?.storeActionsInMemory) {
            await this.storeToolAction({
              userId,
              conversationId,
              toolCall: call,
              result,
              context
            });
          }

          return resultObj;
        }
      } catch (error) {
        logger.error('Tool execution failed', { 
          tool: call.tool, 
          error: error.message 
        });
        return {
          tool: call.tool,
          arguments: call.arguments,
          success: false,
          error: error.message
        };
      }
    });

    // Wait for all tool calls to complete
    const results = await Promise.all(promises);
    
    logger.info('All tool calls completed', { 
      total: toolCalls.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    return results;
  }

  /**
   * Execute a tool call
   */
  async executeToolCall({ tool, arguments: args }) {
    const toolInfo = this.toolRegistry.get(tool);
    if (!toolInfo) {
      throw new Error(`Tool not found: ${tool}`);
    }

    const server = this.servers.get(toolInfo.server);
    if (!server) {
      throw new Error(`Server not found for tool: ${tool}`);
    }

    // Validate required arguments before execution
    const inputSchema = toolInfo.tool.inputSchema;
    if (inputSchema?.required && Array.isArray(inputSchema.required)) {
      for (const requiredParam of inputSchema.required) {
        if (args[requiredParam] === null || args[requiredParam] === undefined) {
          throw new Error(`Missing required parameter: ${requiredParam}`);
        }
        // Ensure string types are actually strings
        if (inputSchema.properties?.[requiredParam]?.type === 'string' && 
            typeof args[requiredParam] !== 'string') {
          args[requiredParam] = String(args[requiredParam]);
        }
      }
    }

    // Clean up null/undefined optional arguments
    const cleanArgs = {};
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== null && value !== undefined) {
        cleanArgs[key] = value;
      }
    }

    // Extract the tool name without server prefix
    const toolName = tool.split('.').slice(1).join('.');

    const timeout = this.config.settings?.toolExecutionTimeout || 30000;

    logger.debug('Executing tool', { tool: toolName, args: cleanArgs });

    // Execute with timeout
    return Promise.race([
      server.instance.call(toolName, cleanArgs),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Tool execution timeout')), timeout)
      )
    ]);
  }

  /**
   * Store tool action in memory for future context
   */
  async storeToolAction({ userId, conversationId, toolCall, result, context }) {
    try {
      const memoryService = this.getMemoryService();
      
      await memoryService.storeEvent({
        userId,
        eventType: 'tool_action',
        domain: toolCall.tool.split('.')[0], // Server name as domain
        userIntent: `Used ${toolCall.tool} with args: ${JSON.stringify(toolCall.arguments)}`,
        systemResponse: `Result: ${JSON.stringify(result).substring(0, 200)}`,
        context: {
          ...context,
          conversation_id: conversationId,
          tool: toolCall.tool,
          arguments: toolCall.arguments,
          success: true
        }
      });

      logger.debug('Tool action stored in memory', { 
        tool: toolCall.tool, 
        userId 
      });
    } catch (error) {
      logger.error('Failed to store tool action', { error: error.message });
      // Don't throw - storing is optional
    }
  }

  /**
   * Get list of all available tools (for debugging/admin)
   */
  getAvailableTools() {
    const tools = [];
    for (const [name, info] of this.toolRegistry) {
      tools.push({
        name,
        server: info.server,
        category: info.category,
        description: info.tool.description,
        inputSchema: info.tool.inputSchema
      });
    }
    return tools;
  }

  /**
   * Get service status
   */
  async getStatus() {
    await this.initialize();

    return {
      enabled: this.config?.settings?.enabled || false,
      initialized: this.isInitialized,
      serversConfigured: this.config?.servers?.length || 0,
      serversConnected: this.servers.size,
      toolsAvailable: this.toolRegistry.size,
      servers: Array.from(this.servers.entries()).map(([name, info]) => ({
        name,
        type: info.config.type,
        category: info.config.category,
        connected: info.instance?.connected || false,
        toolCount: info.tools?.length || 0
      }))
    };
  }

  /**
   * Reload configuration (for hot reload)
   */
  async reload() {
    this.isInitialized = false;
    this.servers.clear();
    this.toolRegistry.clear();
    await this.initialize();
  }
}

module.exports = new MCPService();
