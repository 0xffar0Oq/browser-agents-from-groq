// Background security tool implementations (rep+ inspired): capture access,
// replay, bulk replay attacks, script fetching + Kingfisher/endpoint/parameter
// scanning. Runs in the background service worker (full fetch privileges).

import browser from 'webextension-polyfill';
import { type AttackType, generateAttackRequests, type PositionConfig } from './bulk-replay';
import { backgroundLogger } from './debug-logger';
import { extractEndpoints, extractParameters } from './extractors';
import { type KingfisherHit, scanContentForSecrets } from './kingfisher';
import { type CapturedRequest, networkCapture } from './network-capture';

const REPLAY_HEADER = 'X-Llm-Actions-Replay';
const MAX_BODY_PREVIEW = 20_000;
const MAX_SCRIPT_BYTES = 2_000_000;
const MAX_BULK_REQUESTS = 200;

async function getActiveTabId(): Promise<number> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) throw new Error('No active tab found');
  return tabId;
}

function truncate(text: string, max = MAX_BODY_PREVIEW): string {
  return text.length > max
    ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
    : text;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function summarizeCapture(req: CapturedRequest): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: req.url,
    status: req.statusCode,
    type: req.type,
    time: new Date(req.timeStamp).toISOString(),
    requestBodyLength: req.requestBody ? req.requestBody.length : 0,
    requestHeaders: req.requestHeaders?.length ?? 0,
    responseHeaders: req.responseHeaders?.length ?? 0,
  };
}

export async function captureList(
  options: {
    action?: 'list' | 'get' | 'clear';
    id?: string;
    method?: string;
    domain?: string;
    search?: string;
    limit?: number;
  } = {},
): Promise<unknown> {
  const tabId = await getActiveTabId();
  const action = options.action || 'list';
  if (action === 'clear') {
    networkCapture.clear(tabId);
    return { success: true, cleared: true, tabId };
  }
  if (action === 'get') {
    if (!options.id) throw new Error('id is required for action=get');
    const req = networkCapture.get(tabId, options.id);
    if (!req) throw new Error(`Captured request ${options.id} not found for this tab`);
    return {
      success: true,
      request: {
        ...summarizeCapture(req),
        initiator: req.initiator,
        requestHeaders: req.requestHeaders,
        requestBody: req.requestBody ?? null,
        statusLine: req.statusLine,
        responseHeaders: req.responseHeaders,
      },
    };
  }
  const items = networkCapture.list(tabId, options);
  return {
    success: true,
    tabId,
    count: items.length,
    requests: items.map(summarizeCapture),
    note: 'Use action=get with an id for headers/bodies. Response bodies are not captured (webRequest limitation) — use replay_request to fetch content.',
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface ReplayArgs {
  id?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  params?: Record<string, string>;
  maxResponseChars?: number;
}

export async function replayRequest(args: ReplayArgs): Promise<unknown> {
  const tabId = await getActiveTabId();
  let url = args.url;
  let method = (args.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(args.headers || {}) };
  let body = args.body;

  if (args.id) {
    const captured = networkCapture.get(tabId, args.id);
    if (!captured) throw new Error(`Captured request ${args.id} not found for this tab`);
    url = url || captured.url;
    if (!args.method) method = captured.method;
    if (!args.headers) {
      for (const h of captured.requestHeaders || []) {
        if (/^(content-type|accept|authorization|cookie|x-|referer)/i.test(h.name) && h.value) {
          headers[h.name] = h.value;
        }
      }
    }
    if (body === undefined && method !== 'GET' && method !== 'HEAD') {
      body = captured.requestBody ?? undefined;
    }
  }

  if (!url) throw new Error('Provide url or a captured request id to replay');
  if (args.params) {
    const u = new URL(url, 'https://placeholder.invalid');
    for (const [k, v] of Object.entries(args.params)) u.searchParams.set(k, v);
    url =
      u.origin === 'https://placeholder.invalid' ? `${u.pathname}?${u.searchParams}` : u.toString();
  }

  const started = Date.now();
  headers[REPLAY_HEADER] = 'true';

  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    credentials: 'include',
    redirect: 'follow',
  });
  const elapsed = Date.now() - started;
  const text = await response.text().catch(() => '');
  const interestingHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (
      /^(content-type|content-length|location|set-cookie|www-authenticate|server|access-control|x-)/i.test(
        name,
      )
    ) {
      interestingHeaders[name] = value;
    }
  });

  return {
    success: true,
    request: { url, method, headers },
    response: {
      status: response.status,
      statusText: response.statusText,
      elapsedMs: elapsed,
      headers: interestingHeaders,
      body: truncate(text, args.maxResponseChars ?? MAX_BODY_PREVIEW),
      bodyLength: text.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Raw HTTP request parsing (Burp-style templates)
// ---------------------------------------------------------------------------

export interface ParsedRawRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  host: string;
}

export function parseRawRequest(raw: string): ParsedRawRequest {
  const normalized = raw.replace(/\r\n/g, '\n');
  const [headerPart, ...rest] = normalized.split('\n\n');
  const lines = headerPart.split('\n');
  const requestLine = lines[0]?.trim() || '';
  const match = requestLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+$/i);
  if (!match) {
    throw new Error(
      `Invalid request template. Expected "METHOD /path HTTP/1.1" as the first line, got: "${requestLine}"`,
    );
  }
  const method = match[1].toUpperCase();
  const path = match[2];
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const host = headers.Host || headers.host || '';
  if (!host) throw new Error('Request template is missing a Host header');
  return { method, path, headers, body: rest.join('\n\n'), host };
}

export function buildUrl(parsed: ParsedRawRequest, extraBase?: string): string {
  if (extraBase) {
    const base = extraBase.replace(/\/$/, '');
    return `${base}${parsed.path}`;
  }
  const proto =
    /^(:443|https)/.test(parsed.path) || parsed.path.startsWith('/') ? 'https' : 'https';
  const host = parsed.host.replace(/:\d+$/, '');
  const port = /:(\d+)$/.exec(parsed.host)?.[1];
  const authority = port && port !== '443' && port !== '80' ? `${host}:${port}` : host;
  return `${proto}://${authority}${parsed.path}`;
}

// ---------------------------------------------------------------------------
// Bulk replay
// ---------------------------------------------------------------------------

export interface BulkReplayArgs {
  template: string;
  attackType: AttackType;
  positions: PositionConfig[];
  baseUrl?: string;
  maxRequests?: number;
  delayMs?: number;
  summarize?: boolean;
}

export async function bulkReplay(args: BulkReplayArgs): Promise<unknown> {
  const generated = generateAttackRequests(args.attackType, args.positions, args.template);
  const maxRequests = Math.min(args.maxRequests ?? 25, MAX_BULK_REQUESTS);
  if (generated.length > maxRequests) {
    throw new Error(
      `Attack would generate ${generated.length} requests; max allowed is ${maxRequests}. Reduce payload lists or raise maxRequests (hard cap ${MAX_BULK_REQUESTS}).`,
    );
  }

  const results: Array<Record<string, unknown>> = [];
  const statusGroups: Record<string, number> = {};
  let index = 0;

  for (const gen of generated) {
    const started = Date.now();
    try {
      const parsed = parseRawRequest(gen.requestContent);
      const url = buildUrl(parsed, args.baseUrl);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.headers)) {
        if (k.toLowerCase() === 'host') continue;
        headers[k] = v;
      }
      headers[REPLAY_HEADER] = 'true';

      const response = await fetch(url, {
        method: parsed.method,
        headers,
        body: parsed.method === 'GET' || parsed.method === 'HEAD' ? undefined : parsed.body,
        credentials: 'include',
        redirect: 'follow',
      });
      const text = await response.text().catch(() => '');
      const statusKey = String(response.status);
      statusGroups[statusKey] = (statusGroups[statusKey] || 0) + 1;
      index++;
      results.push({
        index,
        payloads: gen.payloads,
        status: response.status,
        ms: Date.now() - started,
        length: text.length,
        // Only include bodies for non-200s or the first few to keep output small
        body: response.status >= 400 || index <= 3 ? truncate(text, 2000) : undefined,
        bodySnippet: undefined,
      });
    } catch (error) {
      index++;
      statusGroups.error = (statusGroups.error || 0) + 1;
      results.push({
        index,
        payloads: gen.payloads,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      });
    }
    if (args.delayMs && args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(args.delayMs ?? 0, 5000)));
    }
  }

  const lengths = results
    .map((r) => (typeof r.length === 'number' ? r.length : -1))
    .filter((l) => l >= 0);
  const avgLength = lengths.length
    ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
    : 0;

  return {
    success: true,
    attackType: args.attackType,
    total: results.length,
    statusGroups,
    avgLength,
    outliers: results.filter(
      (r) =>
        (typeof r.length === 'number' &&
          Math.abs(r.length - avgLength) > avgLength * 0.3 &&
          avgLength > 0) ||
        (typeof r.status === 'number' && r.status >= 400) ||
        r.error,
    ),
    results: args.summarize === false ? results : results.map((r) => ({ ...r, body: undefined })),
  };
}

// ---------------------------------------------------------------------------
// Fetch + scan
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<{ content: string; truncated: boolean }> {
  const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!response.ok) throw new Error(`Fetch failed for ${url}: HTTP ${response.status}`);
  let text = await response.text();
  let truncated = false;
  if (text.length > MAX_SCRIPT_BYTES) {
    text = text.slice(0, MAX_SCRIPT_BYTES);
    truncated = true;
  }
  return { content: text, truncated };
}

export type ScanKind = 'secrets' | 'endpoints' | 'parameters' | 'all';

export interface ScanOutput {
  file: string;
  secrets?: KingfisherHit[];
  endpoints?: unknown[];
  parameters?: unknown[];
  truncated?: boolean;
}

export async function scanUrl(url: string, kind: ScanKind = 'all'): Promise<unknown> {
  const { content, truncated } = await fetchText(url);
  return scanContent(content, url, kind, truncated);
}

export function scanContent(
  content: string,
  file: string,
  kind: ScanKind = 'all',
  truncated = false,
): Promise<ScanOutput> | ScanOutput {
  const out: ScanOutput = { file, truncated };
  const tasks: Array<Promise<void>> = [];

  const wants = (k: ScanKind) => kind === 'all' || kind === k;

  if (wants('secrets')) {
    tasks.push(
      scanContentForSecrets(content, file).then((hits) => {
        out.secrets = hits.map((h) => ({
          ...h,
          match:
            h.match.length > 12
              ? `${h.match.slice(0, 6)}…${h.match.slice(-4)}`
              : `${h.match.slice(0, 2)}…${h.match.slice(-2)}`,
        }));
      }),
    );
  }
  if (wants('endpoints')) {
    out.endpoints = extractEndpoints(content, file);
  }
  if (wants('parameters')) {
    const endpointHints =
      wants('endpoints') && Array.isArray(out.endpoints)
        ? (out.endpoints as Array<{ endpoint: string }>).map((e) => e.endpoint)
        : [];
    out.parameters = extractParameters(content, endpointHints);
  }

  if (tasks.length === 0) return out as ScanOutput;
  return Promise.all(tasks).then(() => out);
}

export async function scanPageScripts(kind: ScanKind = 'all', limit = 15): Promise<unknown> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) throw new Error('No active tab found');

  let urls: string[];
  try {
    urls = (await browser.tabs.sendMessage(tabId, {
      type: 'EXECUTE_FUNCTION',
      function: 'getScriptUrls',
      arguments: {},
    })) as any;
    // sendMessage wraps: content returns {success, result}
    const resp = urls as unknown as { success?: boolean; result?: string[] };
    if (resp && Array.isArray(resp.result)) urls = resp.result;
    else if (resp && resp.success === false) throw new Error(resp as any);
  } catch (error) {
    throw new Error(
      `Could not list page scripts: ${error instanceof Error ? error.message : String(error)}. Is the content script injected on this page?`,
    );
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: true, files: [], note: 'No script URLs found on this page.' };
  }

  const limited = urls.slice(0, Math.min(limit, 30));
  const scans: ScanOutput[] = [];
  const failures: Array<{ url: string; error: string }> = [];

  for (const url of limited) {
    try {
      const { content, truncated } = await fetchText(url);
      scans.push(await scanContent(content, url, kind, truncated));
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const allSecrets = scans.flatMap((s) => s.secrets ?? []);
  const allEndpoints = scans.flatMap((s) => (s.endpoints as unknown[]) ?? []);
  const allParameters = scans.flatMap((s) => (s.parameters as unknown[]) ?? []);

  backgroundLogger.info('Page script scan completed', {
    files: scans.length,
    failures: failures.length,
    secrets: allSecrets.length,
    endpoints: allEndpoints.length,
    parameters: allParameters.length,
  });

  return {
    success: true,
    scanned: scans.length,
    skipped: urls.length - limited.length,
    failures,
    totalSecrets: allSecrets.length,
    secrets: allSecrets,
    totalEndpoints: allEndpoints.length,
    endpoints: allEndpoints.slice(0, 100),
    totalParameters: allParameters.length,
    parameters: allParameters.slice(0, 100),
    files: scans.map((s) => ({
      file: s.file,
      secrets: s.secrets?.length ?? 0,
      endpoints: (s.endpoints as unknown[] | undefined)?.length ?? 0,
      parameters: (s.parameters as unknown[] | undefined)?.length ?? 0,
      truncated: s.truncated,
    })),
  };
}
