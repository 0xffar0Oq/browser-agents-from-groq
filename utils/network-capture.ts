// Network capture store (rep+ inspired).
// Passive webRequest capture in the background service worker: per-tab ring
// buffer of request/response metadata for the LLM security tools.

import browser from 'webextension-polyfill';
import { MAX_CAPTURE_BODY_BYTES, MAX_CAPTURED_REQUESTS } from './constants';
import { backgroundLogger } from './debug-logger';

export interface CapturedHeader {
  name: string;
  value?: string;
}

export interface CapturedRequest {
  id: string;
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  type: string;
  timeStamp: number;
  initiator?: string;
  requestBody?: string | null;
  requestHeaders?: CapturedHeader[];
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: CapturedHeader[];
}

// Minimal structural types for webRequest details (avoids chrome namespace types).
interface WebRequestDetails {
  requestId: string;
  url: string;
  method: string;
  type: string;
  tabId: number;
  timeStamp?: number;
  initiator?: string;
  requestBody?: { raw?: Array<{ bytes?: unknown }>; formData?: Record<string, string | string[]> };
  requestHeaders?: CapturedHeader[];
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: CapturedHeader[];
}

const STATIC_EXTENSIONS = [
  '.css',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.pdf',
];

const EXTENSION_HOST_PATTERN = /^[a-z]{32}$/i;
const REPLAY_HEADER = 'X-Llm-Actions-Replay';

function isStaticResource(url: string): boolean {
  const lower = url.toLowerCase();
  return STATIC_EXTENSIONS.some((ext) => lower.endsWith(ext) || lower.includes(`${ext}?`));
}

function isExtensionUrl(url: string): boolean {
  if (
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://') ||
    url.startsWith('moz-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    return true;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EXTENSION_HOST_PATTERN.test(host);
  } catch {
    return false;
  }
}

function parseRequestBody(requestBody?: WebRequestDetails['requestBody']): string | null {
  if (!requestBody) return null;
  try {
    if (requestBody.raw && requestBody.raw.length > 0) {
      const decoder = new TextDecoder('utf-8');
      const parts = requestBody.raw.map((entry) =>
        entry.bytes ? decoder.decode(entry.bytes as ArrayBuffer) : '',
      );
      return parts.join('').slice(0, MAX_CAPTURE_BODY_BYTES);
    }
    if (requestBody.formData) {
      const params = new URLSearchParams();
      for (const [key, values] of Object.entries(requestBody.formData)) {
        for (const value of Array.isArray(values) ? values : [values]) params.append(key, value);
      }
      return params.toString().slice(0, MAX_CAPTURE_BODY_BYTES);
    }
  } catch (error) {
    backgroundLogger.debug('Failed to parse captured request body', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

class NetworkCaptureStore {
  private pending = new Map<string, CapturedRequest>();
  private buffers = new Map<number, CapturedRequest[]>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    const webRequest = browser.webRequest;
    if (!webRequest) {
      backgroundLogger.warn('webRequest API unavailable; network capture disabled');
      return;
    }

    webRequest.onBeforeRequest.addListener(
      (details) => {
        this.onBeforeRequest(details);
      },
      { urls: ['<all_urls>'] },
      ['requestBody'],
    );
    webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const entry = this.pending.get(details.requestId);
        if (entry && details.requestHeaders) {
          entry.requestHeaders = details.requestHeaders;
        }
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders'],
    );
    webRequest.onCompleted.addListener(
      (details) => {
        this.onCompleted(details);
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders'],
    );
    webRequest.onErrorOccurred.addListener(
      (details) => {
        this.pending.delete(details.requestId);
      },
      { urls: ['<all_urls>'] },
    );

    setInterval(() => this.cleanup(), 60_000);
    backgroundLogger.info('Network capture listeners registered');
  }

  private onBeforeRequest(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    if (isExtensionUrl(details.url)) return;
    if (isStaticResource(details.url)) return;

    const headers = details.requestHeaders || [];
    const isReplay = headers.some(
      (h) => h.name.toLowerCase() === REPLAY_HEADER.toLowerCase() && h.value === 'true',
    );
    if (isReplay) return;

    this.pending.set(details.requestId, {
      id: details.requestId,
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      timeStamp: Date.now(),
      initiator: details.initiator,
      requestBody: parseRequestBody(details.requestBody),
    });
  }

  private onCompleted(details: WebRequestDetails): void {
    const req = this.pending.get(details.requestId);
    if (!req) return;
    this.pending.delete(details.requestId);

    req.statusCode = details.statusCode;
    req.statusLine = details.statusLine;
    req.responseHeaders = details.responseHeaders;

    let buffer = this.buffers.get(req.tabId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(req.tabId, buffer);
    }
    buffer.push(req);
    if (buffer.length > MAX_CAPTURED_REQUESTS) {
      buffer.splice(0, buffer.length - MAX_CAPTURED_REQUESTS);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, req] of this.pending) {
      if (now - req.timeStamp > 60_000) this.pending.delete(id);
    }
    for (const [tabId, buffer] of this.buffers) {
      const fresh = buffer.filter((r) => now - r.timeStamp < 10 * 60_000);
      if (fresh.length !== buffer.length) this.buffers.set(tabId, fresh);
    }
  }

  list(
    tabId: number,
    options?: { method?: string; domain?: string; search?: string; limit?: number },
  ): CapturedRequest[] {
    let items = [...(this.buffers.get(tabId) || [])].reverse();
    if (options?.method) {
      const method = options.method.toUpperCase();
      items = items.filter((r) => r.method === method);
    }
    if (options?.domain) {
      const domain = options.domain.toLowerCase();
      items = items.filter((r) => {
        try {
          return new URL(r.url).hostname.toLowerCase().includes(domain);
        } catch {
          return false;
        }
      });
    }
    if (options?.search) {
      const needle = options.search.toLowerCase();
      items = items.filter((r) => r.url.toLowerCase().includes(needle));
    }
    const limit = Math.min(options?.limit ?? 50, MAX_CAPTURED_REQUESTS);
    return items.slice(0, limit);
  }

  get(tabId: number, id: string): CapturedRequest | undefined {
    return (this.buffers.get(tabId) || []).find((r) => r.id === id || r.requestId === id);
  }

  clear(tabId: number): void {
    this.buffers.delete(tabId);
  }
}

export const networkCapture = new NetworkCaptureStore();
