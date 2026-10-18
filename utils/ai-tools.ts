import { tool } from 'ai';
import browser from 'webextension-polyfill';
import { z } from 'zod/v3';
import { backgroundLogger } from './debug-logger';
import { decode } from './decoders';
import { responseManager } from './response-manager';
import {
  bulkReplay,
  captureList,
  replayRequest,
  scanContent,
  scanPageScripts,
  scanUrl,
} from './security-tools';
import type { ContentScriptFunctionRequest, ContentScriptFunctionResponse } from './types';

/**
 * AI SDK Tool Definitions
 *
 * These tools provide the LLM with the ability to interact with web pages
 * through browser automation. Each tool is defined using the AI SDK's tool()
 * function with Zod schemas for type safety and automatic validation.
 */

/**
 * Convert string boolean values to actual booleans recursively
 */
function convertStringBooleans(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Convert string "true"/"false" to boolean, case-insensitive
    const lowerStr = obj.toLowerCase();
    if (lowerStr === 'true') return true;
    if (lowerStr === 'false') return false;
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(convertStringBooleans);
  }

  if (typeof obj === 'object') {
    const converted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertStringBooleans(value);
    }
    return converted;
  }

  return obj;
}

/**
 * Zod preprocessor for converting string booleans to actual booleans
 */
const booleanPreprocessor = (val: any) => {
  if (typeof val === 'string') {
    const lowerStr = val.toLowerCase();
    if (lowerStr === 'true') return true;
    if (lowerStr === 'false') return false;
  }
  return val;
};

/**
 * Helper to create a boolean schema with string boolean preprocessing
 */
const booleanWithStringConversion = () => z.preprocess(booleanPreprocessor, z.boolean());

/**
 * Execute a function in the content script context
 */
async function executeContentScriptFunction(
  functionName: string,
  args: any,
): Promise<ContentScriptFunctionResponse> {
  const operationId = `tool-${functionName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    backgroundLogger.debug('Tool execution started', {
      operationId,
      functionName,
      args,
    });

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      throw new Error('No active tab found');
    }

    // Convert string booleans to actual booleans to handle LLM parameter issues
    const convertedArgs = convertStringBooleans(args);

    const message: ContentScriptFunctionRequest = {
      type: 'EXECUTE_FUNCTION',
      function: functionName,
      arguments: convertedArgs,
    };

    backgroundLogger.debug('Sending message to content script', {
      operationId,
      tabId: activeTab.id,
      message,
    });

    const response = (await browser.tabs.sendMessage(
      activeTab.id,
      message,
    )) as ContentScriptFunctionResponse;

    if (!response.success) {
      backgroundLogger.error('Tool execution failed', {
        operationId,
        functionName,
        error: response.error,
      });
      throw new Error(response.error || `Failed to execute ${functionName}`);
    }

    backgroundLogger.info('Tool execution completed successfully', {
      operationId,
      functionName,
      hasResult: !!response.result,
      resultType: typeof response.result,
    });

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    backgroundLogger.error('Tool execution error', {
      operationId,
      functionName,
      error: errorMessage,
      args,
    });

    backgroundLogger.error(`Error executing content script function ${functionName}`, {
      functionName,
      error,
      args,
    });

    // Provide more specific error information for debugging
    if (errorMessage.includes('not found')) {
      backgroundLogger.warn(
        `Tool '${functionName}' is not implemented in the content script. Check if it needs to be added to the llm-helper.ts interface and content script switch statement.`,
        { functionName },
      );
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Execute a function and apply global response truncation
 */
async function executeWithTruncation(
  functionName: string,
  args: any,
  customPageSize?: number,
): Promise<any> {
  const result = await executeContentScriptFunction(functionName, args);

  if (!result.success) {
    return result; // Return errors without truncation
  }

  // Apply global truncation to the result
  const truncationResult = responseManager.truncateResponse(
    result.result,
    functionName,
    customPageSize,
  );

  const response = {
    success: true,
    result: truncationResult.content,
  };

  // Only include pagination metadata if there are multiple pages
  if (truncationResult.totalPages > 1) {
    (response as any)._meta = {
      isTruncated: truncationResult.isTruncated,
      originalLength: truncationResult.originalLength,
      currentPage: truncationResult.currentPage,
      totalPages: truncationResult.totalPages,
      hasMore: truncationResult.hasMore,
      responseId: truncationResult.responseId,
    };
  }

  return response;
}

/**
 * Screenshot Tool
 * Captures a screenshot of the current page or viewport
 */
export const screenshotTool = tool({
  description:
    'Capture a screenshot of the current page. Use this to see what the user is looking at or to analyze visual content.',
  inputSchema: z.object({
    fullPage: booleanWithStringConversion()
      .optional()
      .default(false)
      .describe('Whether to capture the full page (true) or just the visible viewport (false)'),
  }),
  execute: async ({ fullPage }) => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (!activeTab?.id) {
        throw new Error('No active tab found');
      }

      // Capture screenshot using browser API
      const dataUrl = await browser.tabs.captureVisibleTab(undefined, {
        format: 'png',
        quality: 90,
      });

      return {
        type: 'screenshot',
        success: true,
        dataUrl,
        timestamp: Date.now(),
        fullPage,
      };
    } catch (error) {
      backgroundLogger.error('Screenshot capture error', { error, fullPage });
      return {
        type: 'screenshot',
        success: false,
        error: error instanceof Error ? error.message : 'Screenshot capture failed',
      };
    }
  },
});

/**
 * Find Elements Tool
 * Find elements on the page by text content or CSS selector
 */
export const findElementsTool = tool({
  description:
    'Find elements on the current page by text pattern or CSS selector. Returns details about matching elements including their text content, attributes, and position.',
  inputSchema: z.object({
    pattern: z
      .string()
      .describe(
        'Text pattern to search for or CSS selector (e.g., "button", ".class-name", "#id", or "download" for text search)',
      ),
    options: z
      .object({
        limit: z.number().optional().default(10).describe('Maximum number of elements to return'),
        includeHidden: booleanWithStringConversion()
          .optional()
          .default(false)
          .describe('Whether to include hidden elements'),
        searchType: z
          .enum(['text', 'selector', 'auto'])
          .optional()
          .default('auto')
          .describe(
            'Type of search: text (search by text content), selector (CSS selector), auto (detect automatically)',
          ),
      })
      .optional(),
  }),
  execute: async ({ pattern, options = {} }) => {
    const result = await executeWithTruncation('find', {
      pattern,
      options: {
        limit: options?.limit ?? 10,
        includeHidden: options?.includeHidden ?? false,
        searchType: options?.searchType ?? 'auto',
      },
    });

    return result.success ? result : { error: result.error };
  },
});

/**
 * Extract Text Tool
 * Extract text content from specific elements or the entire page
 */
export const extractTextTool = tool({
  description:
    'Extract text content from the page. Can extract from specific elements using selectors or get all text content.',
  inputSchema: z.object({
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector to extract text from specific elements. If not provided, extracts all page text.',
      ),
    options: z
      .object({
        includeLinks: booleanWithStringConversion()
          .optional()
          .default(true)
          .describe('Whether to include link text'),
        includeButtons: booleanWithStringConversion()
          .optional()
          .default(true)
          .describe('Whether to include button text'),
        maxLength: z.number().optional().default(5000).describe('Maximum length of extracted text'),
        format: z
          .enum(['plain', 'structured'])
          .optional()
          .default('plain')
          .describe('Format of output: plain (simple text) or structured (with element types)'),
      })
      .optional(),
  }),
  execute: async ({ selector, options = {} }) => {
    const customPageSize =
      options?.maxLength && options.maxLength !== 5000 ? options.maxLength : undefined;

    const result = await executeWithTruncation(
      'extract',
      {
        selector,
        options: {
          includeLinks: options?.includeLinks !== false,
          includeButtons: options?.includeButtons !== false,
          maxLength: options?.maxLength || 5000,
          format: options?.format || 'plain',
        },
      },
      customPageSize,
    );

    return result.success ? result : { error: result.error };
  },
});

/**
 * Page Summary Tool
 * Get a summary of the current page including title, main content, and key elements
 */
export const summarizeTool = tool({
  description:
    'Get a comprehensive summary of the current page including title, URL, main headings, key content, and important interactive elements.',
  inputSchema: z.object({
    includeMetadata: booleanWithStringConversion()
      .optional()
      .default(true)
      .describe('Whether to include page metadata (title, URL, description)'),
    includeHeadings: booleanWithStringConversion()
      .optional()
      .default(true)
      .describe('Whether to include page headings structure'),
    includeInteractiveElements: booleanWithStringConversion()
      .optional()
      .default(true)
      .describe('Whether to include buttons, forms, and links'),
    contentLength: z
      .enum(['brief', 'detailed'])
      .optional()
      .default('detailed')
      .describe('Level of detail in the summary'),
  }),
  execute: async ({
    includeMetadata = true,
    includeHeadings = true,
    includeInteractiveElements = true,
    contentLength = 'detailed',
  }) => {
    const result = await executeWithTruncation('summary', {
      includeMetadata,
      includeHeadings,
      includeInteractiveElements,
      contentLength,
    });

    return result.success ? result : { error: result.error };
  },
});

/**
 * Click Element Tool
 * Click on an element by selector or text content
 */
export const clickTool = tool({
  description:
    'Click on an element on the page by CSS selector or visible text. The element is scrolled into view, checked for overlays, and clicked with a realistic pointer/mouse sequence before waiting for the page to react.',
  inputSchema: z.object({
    selector: z.string().optional().describe('CSS selector of the element to click'),
    text: z
      .string()
      .optional()
      .describe('Text content of the element to click (alternative to selector)'),
    options: z
      .object({
        waitAfter: z
          .number()
          .optional()
          .default(1000)
          .describe('Milliseconds to wait after clicking'),
        scrollIntoView: booleanWithStringConversion()
          .optional()
          .default(true)
          .describe('Whether to scroll element into view before clicking'),
      })
      .optional(),
  }),
  execute: async ({ selector, text, options = {} }) => {
    if (!selector && !text) {
      return {
        success: false,
        error: 'Either selector or text must be provided',
      };
    }

    const result = await executeWithTruncation('click', {
      selector,
      text,
      options: {
        waitAfter: options?.waitAfter || 1000,
        scrollIntoView: options?.scrollIntoView !== false,
      },
    });

    if (!result.success) {
      return { error: result.error };
    }

    // Handle case where multiple elements were found
    if (
      typeof result.result === 'object' &&
      result.result.action === 'click' &&
      result.result.elements
    ) {
      const elements = result.result.elements;
      const searchText = result.result.searchText;

      // Create helpful guidance for each element
      const elementInstructions = elements
        .map((el: any, index: number) => {
          const elementType = el.tag;
          const elementText = el.text ? `"${el.text}"` : 'no text';
          const classes = el.classes ? ` with classes "${el.classes}"` : '';

          return `${index + 1}. ${elementType} element (${elementText})${classes}\n   Use: click(selector: "${el.selector}")`;
        })
        .join('\n');

      return {
        success: true,
        result: `Multiple elements found containing "${searchText}". Please choose one:\n\n${elementInstructions}`,
        elements: result.result.elements,
        total: result.result.total,
      };
    }

    return result;
  },
});

/**
 * Type Text Tool
 * Type text into an input field or text area
 */
export const typeTool = tool({
  description: 'Type text into an input field, textarea, or other editable element on the page.',
  inputSchema: z.object({
    selector: z.string().optional().describe('CSS selector of the input element'),
    text: z.string().describe('Text to type into the element'),
    options: z
      .object({
        clear: booleanWithStringConversion()
          .optional()
          .default(true)
          .describe('Whether to clear existing content before typing'),
        delay: z
          .number()
          .optional()
          .default(10)
          .describe('Delay between keystrokes in milliseconds'),
        pressEnter: booleanWithStringConversion()
          .optional()
          .default(false)
          .describe('Whether to press Enter after typing'),
      })
      .optional(),
  }),
  execute: async ({ selector, text, options = {} }) => {
    const result = await executeWithTruncation('type', {
      selector,
      text,
      options: {
        clear: options?.clear !== false,
        delay: options?.delay || 100,
        pressEnter: options?.pressEnter || false,
      },
    });

    return result.success ? result : { error: result.error };
  },
});

/**
 * Get Response Page Tool
 * Retrieve a specific page of a previously truncated response
 */
export const getResponsePageTool = tool({
  description:
    'Get a specific page of a previously truncated tool response. Use this when a tool result shows it was truncated and you need to see more content. The response will include pagination metadata.',
  inputSchema: z.object({
    responseId: z.string().describe('The response ID from the truncated result metadata'),
    page: z.number().min(1).describe('The page number to retrieve (starting from 1)'),
  }),
  execute: async ({ responseId, page }) => {
    try {
      // Execute through content script function handler to ensure proper message routing
      const result = await executeContentScriptFunction('getResponsePage', { responseId, page });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Failed to retrieve page',
        };
      }

      return {
        success: true,
        result: result.result,
        _meta: (result as any)._meta,
      };
    } catch (error) {
      backgroundLogger.error('Error getting response page', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get response page',
      };
    }
  },
});

/**
 * Security superpowers tools (rep+ port: capture/replay/attack/scan/decode)
 */

async function requireBackgroundResult<T>(promise: T | Promise<T>): Promise<any> {
  try {
    return await promise;
  } catch (error) {
    backgroundLogger.error('Security tool failed', { error });
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const captureRequestsTool = tool({
  description:
    'Inspect requests passively captured from the active tab (webRequest). action=list shows recent requests (filter by method/domain/search); action=get returns headers + request body for one id; action=clear empties the buffer.',
  inputSchema: z.object({
    action: z.enum(['list', 'get', 'clear']).optional().default('list'),
    id: z.string().optional().describe('Capture id (required for action=get)'),
    method: z.string().optional().describe('Filter by HTTP method, e.g. POST'),
    domain: z.string().optional().describe('Filter by domain substring'),
    search: z.string().optional().describe('Filter by URL substring'),
    limit: z.number().optional().default(50).describe('Max requests to return'),
  }),
  execute: async (args) => requireBackgroundResult(captureList(args)),
});

export const replayRequestTool = tool({
  description:
    'Re-send an HTTP request and return status/headers/body. Provide a captured request id, or build a request with url/method/headers/body/params. Adds X-Llm-Actions-Replay so the replay is never re-captured. Use for confirming tampered parameters, fetching resources, and reading response bodies.',
  inputSchema: z.object({
    id: z.string().optional().describe('Captured request id from capture_requests'),
    url: z.string().optional().describe('Full URL (required if no id)'),
    method: z.string().optional().default('GET'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    params: z.record(z.string(), z.string()).optional().describe('Query params to set/override'),
    maxResponseChars: z.number().optional().describe('Max response body chars to return'),
  }),
  execute: async (args) => requireBackgroundResult(replayRequest(args)),
});

export const bulkReplayTool = tool({
  description:
    'Burp Intruder-style bulk attack. template is a raw HTTP request (first line "POST /path HTTP/1.1", Host header, blank line, body) containing §position§ markers. attackType: sniper (one position at a time), battering-ram (same payload everywhere), pitchfork (zip lists), cluster-bomb (cartesian product). positions: one per §marker§ with type simple-list (newline payloads) or numbers {from,to,step}. Returns status groups, length outliers and response snippets. Keep payload sets small.',
  inputSchema: z.object({
    template: z.string().describe('Raw HTTP request template with §markers§'),
    attackType: z.enum(['sniper', 'battering-ram', 'pitchfork', 'cluster-bomb']),
    positions: z
      .array(
        z.object({
          type: z.enum(['simple-list', 'numbers']),
          list: z.string().optional().describe('Newline-separated payloads (simple-list)'),
          numbers: z
            .object({ from: z.number(), to: z.number(), step: z.number() })
            .optional()
            .describe('Range (numbers)'),
        }),
      )
      .describe('One entry per §marker§, in order'),
    baseUrl: z.string().optional().describe('Override origin, e.g. https://target.tld'),
    maxRequests: z
      .number()
      .optional()
      .default(25)
      .describe('Cap on generated requests (hard max 200)'),
    delayMs: z.number().optional().describe('Delay between requests'),
    summarize: z.boolean().optional().default(true).describe('Omit response bodies from results'),
  }),
  execute: async (args) =>
    requireBackgroundResult(bulkReplay(args as Parameters<typeof bulkReplay>[0])),
});

export const decodeTool = tool({
  description:
    'Decode an encoded string: base64, url encoding, JWT (header/payload/signature + expiry), or hex. auto detects the format.',
  inputSchema: z.object({
    input: z.string().describe('Encoded string to decode'),
    format: z.enum(['auto', 'base64', 'url', 'jwt', 'hex']).optional().default('auto'),
  }),
  execute: async ({ input, format }) => {
    try {
      return { success: true, result: decode(input, format ?? 'auto') };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const scanSecretsTool = tool({
  description:
    'Scan a JavaScript file (by URL) or raw content with Kingfisher secret-detection rules (API keys, tokens, JWTs, private keys). Returns rule name, masked match, entropy and confidence. Fetch the URL of a script from the page or a captured request.',
  inputSchema: z.object({
    url: z.string().optional().describe('URL of a JS/text resource to fetch and scan'),
    content: z.string().optional().describe('Raw content to scan instead of a URL'),
    file: z.string().optional().describe('Label for content scans'),
  }),
  execute: async ({ url, content, file }) => {
    if (!url && !content) return { success: false, error: 'Provide url or content' };
    if (url) return requireBackgroundResult(scanUrl(url, 'secrets'));
    return requireBackgroundResult(
      scanContent(content as string, file || 'inline-content', 'secrets'),
    );
  },
});

export const extractEndpointsTool = tool({
  description:
    'Extract API endpoints from JavaScript source (URL or raw content): paths, fetch/axios calls, GraphQL and REST endpoints, each with guessed HTTP method, confidence and source file.',
  inputSchema: z.object({
    url: z.string().optional().describe('JS file URL to fetch and scan'),
    content: z.string().optional().describe('Raw JavaScript content to scan'),
    file: z.string().optional().describe('Label for content scans'),
  }),
  execute: async ({ url, content, file }) => {
    if (!url && !content) return { success: false, error: 'Provide url or content' };
    if (url) return requireBackgroundResult(scanUrl(url, 'endpoints'));
    return requireBackgroundResult(
      scanContent(content as string, file || 'inline-content', 'endpoints'),
    );
  },
});

export const extractParametersTool = tool({
  description:
    'Extract parameters from JavaScript source (URL or raw content): query/body/header/path locations, with risk level (high: auth/role/debug, medium: idor) and confidence. Use alongside extract_endpoints to find IDOR/auth candidates.',
  inputSchema: z.object({
    url: z.string().optional().describe('JS file URL to fetch and scan'),
    content: z.string().optional().describe('Raw JavaScript content to scan'),
    file: z.string().optional().describe('Label for content scans'),
  }),
  execute: async ({ url, content, file }) => {
    if (!url && !content) return { success: false, error: 'Provide url or content' };
    if (url) return requireBackgroundResult(scanUrl(url, 'parameters'));
    return requireBackgroundResult(
      scanContent(content as string, file || 'inline-content', 'parameters'),
    );
  },
});

export const scanPageScriptsTool = tool({
  description:
    'List all scripts on the active page and scan them (secrets, endpoints, parameters) by fetching each from the background. Returns aggregated findings plus per-file counts. scan: all (default), secrets, endpoints or parameters.',
  inputSchema: z.object({
    scan: z.enum(['all', 'secrets', 'endpoints', 'parameters']).optional().default('all'),
    limit: z.number().optional().default(15).describe('Max number of scripts to fetch'),
  }),
  execute: async ({ scan, limit }) =>
    requireBackgroundResult(scanPageScripts(scan ?? 'all', limit ?? 15)),
});

/**
 * TradingView tools (content script)
 */

export const tvMarketInfoTool = tool({
  description:
    'TradingView: get current market info for the active chart — symbol, last price, change, high/low/open. Reads the live quote stream (WebSocket sniff) with DOM legend fallback.',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await executeContentScriptFunction('tv_market_info', {});
    return result.success ? result.result : { success: false, error: result.error };
  },
});

export const tvTicketStateTool = tool({
  description:
    'TradingView: read the order ticket state — which side is selected, all input fields (quantity/price) and the available buy/sell/order-type buttons. Use before tv_place_order.',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await executeContentScriptFunction('tv_ticket_state', {});
    return result.success ? result.result : { success: false, error: result.error };
  },
});

export const tvPlaceOrderTool = tool({
  description:
    'TradingView: place an order through the on-page order ticket. HARD RULE: only call when the user explicitly asked to place this exact order (side + quantity) in their latest message. confirm=false returns a preview only; confirm=true fills the ticket (side, quantity, price for limit/stop) and clicks submit. Returns an error if no order ticket is open.',
  inputSchema: z.object({
    side: z.enum(['buy', 'sell']),
    quantity: z.string().describe('Order quantity/size as shown in the ticket'),
    orderType: z.enum(['market', 'limit', 'stop', 'stop-limit']).optional().default('market'),
    limitPrice: z.string().optional().describe('Price for limit orders'),
    stopPrice: z.string().optional().describe('Price for stop orders'),
    confirm: booleanWithStringConversion()
      .optional()
      .default(false)
      .describe('Must be true to actually submit; false returns a preview'),
  }),
  execute: async (args) => {
    const result = await executeContentScriptFunction('tv_place_order', args);
    return result.success ? result.result : { success: false, error: result.error };
  },
});

export const tvOpenPositionsTool = tool({
  description:
    'TradingView: list open positions from the trade panel (symbol, side, quantity, average price, P&L).',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await executeContentScriptFunction('tv_open_positions', {});
    return result.success ? result.result : { success: false, error: result.error };
  },
});

export const tvDetectBalanceTool = tool({
  description:
    'TradingView: detect account balance/equity/buying power by scanning the page for labeled amounts. Use before tv_position_size when balance is unknown.',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await executeContentScriptFunction('tv_detect_balance', {});
    return result.success ? result.result : { success: false, error: result.error };
  },
});

export const tvPositionSizeTool = tool({
  description:
    'Risk-based position sizing (BSD-style): given balance, risk %, entry price, stop distance %, contract point value and quantity step, returns stop price, risk cash, raw/floored quantity and estimated loss. If balance is omitted it is auto-detected from the page. Advisory only — no orders are placed.',
  inputSchema: z.object({
    balance: z.number().optional().describe('Account balance; auto-detected if omitted'),
    riskPercent: z.number().describe('Risk per trade in percent of balance, e.g. 1'),
    entryPrice: z.number().describe('Planned entry price'),
    stopPercent: z.number().describe('Stop distance as percent of entry price, e.g. 0.5'),
    pointValue: z.number().optional().default(1).describe('Contract point value (default 1)'),
    step: z.number().optional().default(1).describe('Quantity step/lot size (default 1)'),
  }),
  execute: async (args) => {
    const result = await executeContentScriptFunction('tv_position_size', args);
    return result.success ? result.result : { success: false, error: result.error };
  },
});

/**
 * Collection of all available tools
 * This object is used by the AI SDK to provide tools to the LLM
 */
export const availableTools = {
  screenshot: screenshotTool,
  find: findElementsTool,
  extract: extractTextTool,
  summary: summarizeTool,
  click: clickTool,
  type: typeTool,
  getResponsePage: getResponsePageTool,
  captureRequests: captureRequestsTool,
  replayRequest: replayRequestTool,
  bulkReplay: bulkReplayTool,
  decode: decodeTool,
  scanSecrets: scanSecretsTool,
  extractEndpoints: extractEndpointsTool,
  extractParameters: extractParametersTool,
  scanPageScripts: scanPageScriptsTool,
  tvMarketInfo: tvMarketInfoTool,
  tvTicketState: tvTicketStateTool,
  tvPlaceOrder: tvPlaceOrderTool,
  tvOpenPositions: tvOpenPositionsTool,
  tvDetectBalance: tvDetectBalanceTool,
  tvPositionSize: tvPositionSizeTool,
};

/**
 * Get tools based on configuration
 * Allows enabling/disabling specific tool categories
 */
export function getConfiguredTools(
  config: {
    enableScreenshot?: boolean;
    enablePageInteraction?: boolean;
    enableTextExtraction?: boolean;
    enableSecurityTools?: boolean;
    enableTradingTools?: boolean;
  } = {},
): Record<string, any> {
  const {
    enableScreenshot = true,
    enablePageInteraction = true,
    enableTextExtraction = true,
    enableSecurityTools = true,
    enableTradingTools = true,
  } = config;

  const tools: Record<string, any> = {};

  if (enableScreenshot) {
    tools.screenshot = screenshotTool;
  }

  if (enableTextExtraction) {
    tools.find = findElementsTool;
    tools.extract = extractTextTool;
    tools.summary = summarizeTool;
  }

  if (enablePageInteraction) {
    tools.click = clickTool;
    tools.type = typeTool;
  }

  if (enableSecurityTools) {
    tools.captureRequests = captureRequestsTool;
    tools.replayRequest = replayRequestTool;
    tools.bulkReplay = bulkReplayTool;
    tools.decode = decodeTool;
    tools.scanSecrets = scanSecretsTool;
    tools.extractEndpoints = extractEndpointsTool;
    tools.extractParameters = extractParametersTool;
    tools.scanPageScripts = scanPageScriptsTool;
  }

  if (enableTradingTools) {
    tools.tvMarketInfo = tvMarketInfoTool;
    tools.tvTicketState = tvTicketStateTool;
    tools.tvPlaceOrder = tvPlaceOrderTool;
    tools.tvOpenPositions = tvOpenPositionsTool;
    tools.tvDetectBalance = tvDetectBalanceTool;
    tools.tvPositionSize = tvPositionSizeTool;
  }

  // Always include pagination tool since it's needed for managing truncated responses
  tools.getResponsePage = getResponsePageTool;

  return tools;
}

/**
 * Get tools based on extension settings
 * Uses the extension configuration to determine which tools to enable
 */
export function getToolsForSettings(settings: {
  toolsEnabled: boolean;
  screenshotToolEnabled: boolean;
  securityToolsEnabled?: boolean;
  tradingToolsEnabled?: boolean;
}): Record<string, any> {
  if (!settings.toolsEnabled) {
    return {};
  }

  return getConfiguredTools({
    enableScreenshot: settings.screenshotToolEnabled,
    enablePageInteraction: true,
    enableTextExtraction: true,
    enableSecurityTools: settings.securityToolsEnabled ?? true,
    enableTradingTools: settings.tradingToolsEnabled ?? true,
  });
}

/**
 * Tool descriptions for UI display
 */
export const toolDescriptions = {
  screenshot: 'Capture page screenshots',
  find: 'Find elements by text or selector',
  extract: 'Extract text content from page',
  summary: 'Get page summary and overview',
  click: 'Click on page elements',
  type: 'Type text into input fields',
  getResponsePage: 'Get additional pages of truncated responses',
  captureRequests: 'List/inspect passively captured network requests',
  replayRequest: 'Re-send an HTTP request and read the response',
  bulkReplay: 'Intruder-style bulk attacks over §position§ markers',
  decode: 'Decode base64 / URL / JWT / hex',
  scanSecrets: 'Kingfisher secret detection in scripts or content',
  extractEndpoints: 'Extract API endpoints from JavaScript',
  extractParameters: 'Extract parameters with risk levels',
  scanPageScripts: 'Scan all page scripts for secrets/endpoints/params',
  tvMarketInfo: 'TradingView market info (symbol/price/change)',
  tvTicketState: 'Read TradingView order ticket state',
  tvPlaceOrder: 'Place a TradingView order (requires explicit confirm)',
  tvOpenPositions: 'List TradingView open positions',
  tvDetectBalance: 'Detect account balance/equity on the page',
  tvPositionSize: 'Risk-based position size calculator',
};
