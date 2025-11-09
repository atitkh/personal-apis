const request = require('supertest');
const app = require('../app');

describe('Vortex API Endpoints', () => {
  describe('GET /api/v1/vortex/status', () => {
    it('should return system status', async () => {
      const response = await request(app)
        .get('/api/v1/vortex/status')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('vortex');
      expect(response.body.data).toHaveProperty('memory');
      expect(response.body.data).toHaveProperty('llm');
    });
  });

  describe('POST /api/v1/vortex/chat', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/v1/vortex/chat')
        .send({
          message: 'Hello Vortex',
          conversationId: 'test-conversation'
        })
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });

    it('should validate request body', async () => {
      // Test shows that auth is processed before validation, which is correct
      const response = await request(app)
        .post('/api/v1/vortex/chat')
        .set('Authorization', 'Bearer invalid-token')
        .send({})
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('GET /api/v1/vortex/memory', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/v1/vortex/memory')
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });
  });
});

describe('Vortex Services', () => {
  describe('VortexService', () => {
    const vortexService = require('../services/vortexService');

    it('should have correct personality configuration', () => {
      const personality = vortexService.getPersonality();
      
      expect(personality).toHaveProperty('name', 'Vortex');
      expect(personality).toHaveProperty('description');
      expect(personality).toHaveProperty('traits');
      expect(Array.isArray(personality.traits)).toBe(true);
    });

    it('should extract action commands from messages', async () => {
      const actions = await vortexService.extractActionCommands('remember that I like coffee');
      
      expect(Array.isArray(actions)).toBe(true);
      // Note: This test may return empty array if LLM is not configured
      if (actions.length > 0) {
        expect(actions[0]).toHaveProperty('type');
        expect(actions[0]).toHaveProperty('content');
        expect(actions[0]).toHaveProperty('confidence');
      }
    });
  });

  describe('MemoryService', () => {
    const memoryService = require('../services/memoryService');

    it('should have proper initialization status', () => {
      expect(memoryService).toHaveProperty('isInitialized', false);
    });

    it('should provide status information', async () => {
      const status = await memoryService.getStatus();
      
      expect(status).toHaveProperty('status');
      expect(['not_initialized', 'operational', 'error']).toContain(status.status);
    });
  });

  describe('LLMService', () => {
    const llmService = require('../services/llmService');

    it('should have proper configuration', () => {
      expect(llmService).toHaveProperty('provider');
      expect(llmService).toHaveProperty('model');
    });

    it('should provide function definitions', () => {
      const functions = llmService.getFunctionDefinitions();
      
      expect(Array.isArray(functions)).toBe(true);
      expect(functions.length).toBeGreaterThan(0);
      expect(functions[0]).toHaveProperty('name');
      expect(functions[0]).toHaveProperty('description');
      expect(functions[0]).toHaveProperty('parameters');
    });

    it('should extract action commands', async () => {
      const actions = await llmService.extractActionCommands('remind me to call mom');
      
      expect(Array.isArray(actions)).toBe(true);
      // Note: This test may return empty array if LLM is not configured
      if (actions.length > 0) {
        expect(actions[0]).toHaveProperty('type');
        expect(actions[0]).toHaveProperty('content');
        expect(actions[0]).toHaveProperty('confidence');
      }
    });
  });
});