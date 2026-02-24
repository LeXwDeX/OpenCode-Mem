/**
 * AzureOpenAIAgent: Azure OpenAI REST API observation extraction
 *
 * Alternative to SDKAgent that uses Azure OpenAI chat completions
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Azure OpenAI REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini/OpenRouter)
 * - Sync to database and Chroma
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getCredential } from '../../shared/EnvManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

const DEFAULT_AZURE_API_VERSION = '2024-10-21';
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_AZURE_CONTEXT_TOKENS = 128000;

interface AzureChatCompletionsResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AzureOpenAIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Azure OpenAI API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Azure OpenAI agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const { apiKey, endpoint, model, apiVersion } = this.getAzureOpenAIConfig();

      if (!apiKey) {
        throw new Error('Azure OpenAI API key not configured. Set CLAUDE_MEM_AZURE_OPENAI_API_KEY in settings or AZURE_OPENAI_API_KEY environment variable.');
      }

      if (!endpoint || !model) {
        throw new Error('Azure OpenAI endpoint or model not configured. Set CLAUDE_MEM_AZURE_OPENAI_ENDPOINT and CLAUDE_MEM_AZURE_OPENAI_MODEL in settings.');
      }

      // Generate synthetic memorySessionId (Azure OpenAI is stateless)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `azure-openai-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=AzureOpenAI`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryAzureOpenAIMultiTurn(
        session.conversationHistory,
        apiKey,
        endpoint,
        model,
        apiVersion
      );

      if (initResponse.content) {
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'AzureOpenAI'
        );
      } else {
        logger.error('SDK', 'Empty Azure OpenAI init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryAzureOpenAIMultiTurn(
            session.conversationHistory,
            apiKey,
            endpoint,
            model,
            apiVersion
          );

          let tokensUsed = 0;
          if (obsResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'AzureOpenAI',
            lastCwd
          );
        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryAzureOpenAIMultiTurn(
            session.conversationHistory,
            apiKey,
            endpoint,
            model,
            apiVersion
          );

          let tokensUsed = 0;
          if (summaryResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'AzureOpenAI',
            lastCwd
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Azure OpenAI agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Azure OpenAI agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Azure OpenAI API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Azure OpenAI agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query Azure OpenAI via REST API with full conversation history (multi-turn)
   */
  private async queryAzureOpenAIMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    endpoint: string,
    model: string,
    apiVersion: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying Azure OpenAI multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens,
      apiVersion
    });

    const url = `${normalizedEndpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    const body = {
      messages,
      temperature: 0.3,
      max_completion_tokens: 4096
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as AzureChatCompletionsResponse;

    if (data.error) {
      throw new Error(`Azure OpenAI API error: ${data.error.code || 'unknown'} - ${data.error.message || 'Unknown error'}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('SDK', 'Empty response from Azure OpenAI chat completions');
      return { content: '' };
    }

    const tokensUsed = data.usage?.total_tokens;
    return { content, tokensUsed };
  }

  private normalizeEndpoint(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to keep within Azure context window
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    if (totalTokens <= MAX_AZURE_CONTEXT_TOKENS) {
      return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (tokenCount + msgTokens > MAX_AZURE_CONTEXT_TOKENS) {
        logger.warn('SDK', 'Azure context window truncated to token limit', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_AZURE_CONTEXT_TOKENS
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }


  /**
   * Get Azure OpenAI configuration from settings or environment
   */
  private getAzureOpenAIConfig(): { apiKey: string; endpoint: string; model: string; apiVersion: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_AZURE_OPENAI_API_KEY || getCredential('AZURE_OPENAI_API_KEY') || '';
    const endpoint = settings.CLAUDE_MEM_AZURE_OPENAI_ENDPOINT || '';
    const model = settings.CLAUDE_MEM_AZURE_OPENAI_MODEL || '';
    const apiVersion = settings.CLAUDE_MEM_AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

    return { apiKey, endpoint, model, apiVersion };
  }
}

/**
 * Check if Azure OpenAI is available (has API key + endpoint + model configured)
 */
export function isAzureOpenAIAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const apiKey = settings.CLAUDE_MEM_AZURE_OPENAI_API_KEY || getCredential('AZURE_OPENAI_API_KEY') || '';
  const endpoint = settings.CLAUDE_MEM_AZURE_OPENAI_ENDPOINT || '';
  const model = settings.CLAUDE_MEM_AZURE_OPENAI_MODEL || '';

  return !!(apiKey && endpoint && model);
}

/**
 * Check if Azure OpenAI is the selected provider
 */
export function isAzureOpenAISelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'azure';
}
