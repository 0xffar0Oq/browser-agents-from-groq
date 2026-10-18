// Extractors (TS ports of rep+ endpoints.js and parameters.js).
// Endpoint + parameter extraction from JavaScript source and captured requests.

export interface EndpointHit {
  endpoint: string;
  method: string;
  file: string;
  baseUrl: string;
  confidence: number;
  patternType: string;
}

export interface ParameterHit {
  name: string;
  location: 'query' | 'body' | 'header' | 'path';
  context: string;
  riskLevel: 'high' | 'medium' | 'low';
  confidence: number;
}

const ENDPOINT_PATTERNS: Record<string, RegExp> = {
  apiPath: /["'`](\/api\/[a-zA-Z0-9_\-/{}:]+)["'`]/g,
  versionedPath: /["'`](\/v\d+\/[a-zA-Z0-9_\-/{}:]+)["'`]/g,
  fullUrl: /["'`](https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)["'`]/g,
  relativePath: /["'`](\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_\-{}:]+)+)["'`]/g,
  graphqlPath: /["'`](\/graphql|\/gql)["'`]/gi,
  fetchCall: /(?:fetch|axios)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  axiosMethod: /axios\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  templateUrl: /`([^`]*(?:https?:\/\/|\/api\/|\/v\d+\/)[^`]*)`/g,
  restEndpoint:
    /["'`](\/(?:users|auth|login|logout|register|profile|settings|posts|comments|products|orders|payments|upload|download|search|items|entities|resources)(?:\/[a-zA-Z0-9_\-{}:]*)?(?:\/[a-zA-Z0-9_\-{}:]+)*)["'`]/g,
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function extractMethodFromContext(content: string, matchIndex: number, endpoint: string): string {
  const context = content.substring(
    Math.max(0, matchIndex - 100),
    Math.min(content.length, matchIndex + endpoint.length + 100),
  );
  const axiosMatch = context.match(/axios\.(get|post|put|patch|delete|head|options)/i);
  if (axiosMatch) return axiosMatch[1].toUpperCase();
  const fetchMethodMatch = context.match(
    /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i,
  );
  if (fetchMethodMatch) return fetchMethodMatch[1].toUpperCase();
  for (const method of HTTP_METHODS) {
    if (new RegExp(`["'\`]${method}["'\`]`, 'i').test(context)) return method;
  }
  if (endpoint.includes('{id}') || endpoint.includes(':id') || /\/\d+/.test(endpoint)) return 'GET';
  if (
    endpoint.includes('/login') ||
    endpoint.includes('/register') ||
    endpoint.includes('/upload') ||
    endpoint.includes('/create')
  ) {
    return 'POST';
  }
  if (endpoint.includes('/update') || endpoint.includes('/edit')) return 'PUT';
  if (endpoint.includes('/delete') || endpoint.includes('/remove')) return 'DELETE';
  return 'GET';
}

function calculateEndpointConfidence(endpoint: string, method: string, context: string): number {
  let confidence = 50;
  if (endpoint.startsWith('/api/')) confidence += 30;
  if (endpoint.startsWith('/v1/') || endpoint.startsWith('/v2/')) confidence += 25;
  if (endpoint === '/graphql' || endpoint === '/gql') confidence += 30;
  if (method !== 'GET' || context.includes('method')) confidence += 15;
  if (endpoint.includes('{') || endpoint.includes(':')) confidence += 10;
  if (/\/(users|auth|login|posts|products|orders)/.test(endpoint)) confidence += 15;
  if (endpoint.startsWith('http')) confidence += 20;
  if (endpoint.length < 4) confidence -= 20;
  if (!endpoint.includes('/')) confidence -= 15;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|ttf|eot)$/i.test(endpoint)) confidence -= 40;
  return Math.min(100, Math.max(0, confidence));
}

function normalizeSourceFile(sourceFile: string): string {
  if (!sourceFile) return sourceFile;
  try {
    const url = new URL(sourceFile);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return sourceFile.split('?')[0].split('#')[0];
  }
}

function isValidEndpoint(endpoint: string): boolean {
  if (endpoint.length < 3) return false;
  const falsePositives = [
    '//',
    '/\\"',
    '/\\',
    '/node_modules/',
    '/webpack/',
    '/dist/',
    '/build/',
    '/__',
    '/static/',
    '/public/',
    '/images/',
    '/fonts/',
    '/styles/',
    '/scripts/',
  ];
  for (const fp of falsePositives) {
    if (endpoint.includes(fp)) return false;
  }
  return endpoint.startsWith('/') || endpoint.startsWith('http');
}

export function extractEndpoints(content: string, sourceFile: string): EndpointHit[] {
  const results: EndpointHit[] = [];
  const seenEndpoints = new Set<string>();
  if (!content) return results;

  if (sourceFile) {
    const url = sourceFile.toLowerCase();
    const isJS =
      url.endsWith('.js') || url.endsWith('.mjs') || url.includes('.js?') || url.includes('.js&');
    if (!isJS) return results;
  }

  let baseUrl = '';
  try {
    const url = new URL(sourceFile);
    baseUrl = `${url.protocol}//${url.host}`;
  } catch {
    // leave empty
  }

  for (const [patternName, pattern] of Object.entries(ENDPOINT_PATTERNS)) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(regex)) {
      const raw = match[1] || match[2];
      if (!raw) continue;
      const endpoint = raw.replace(/["'`]/g, '').split('?')[0].trim();
      if (!isValidEndpoint(endpoint)) continue;

      const normalizedSourceFile = normalizeSourceFile(sourceFile);
      const uniqueKey = `${endpoint}|${normalizedSourceFile}`;
      if (seenEndpoints.has(uniqueKey)) continue;
      seenEndpoints.add(uniqueKey);

      const method = extractMethodFromContext(content, match.index, endpoint);
      const context = content.substring(
        Math.max(0, match.index - 50),
        Math.min(content.length, match.index + 100),
      );
      const confidence = calculateEndpointConfidence(endpoint, method, context);
      if (confidence >= 30) {
        results.push({
          endpoint,
          method,
          file: sourceFile,
          baseUrl,
          confidence,
          patternType: patternName,
        });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const HIGH_RISK_PATTERNS = {
  auth: /^(password|pwd|pass|passwd|token|api[_-]?key|secret|auth|accessToken|access_token|session|sessionId|session_id|secretKey|secret_key)$/i,
  access:
    /^(role|roles|userRole|user_role|permission|permissions|access|accessLevel|admin|isAdmin|is_admin|adminRole|privilege|privileges)$/i,
  flags:
    /^(debug|debugMode|debug_mode|isDebug|test|testMode|testing|bypass|bypassAuth|skipValidation)$/i,
  idor: /^(id|userId|user_id|userID|uid|ownerId|owner_id|creator|creatorId|recordId|record_id)$/i,
  features:
    /^(feature|features|featureFlag|feature_flag|enabled|disabled|active|inactive|status|state)$/i,
};

const SUPPRESSION_PATTERNS: Record<string, RegExp> = {
  buildTools: /(webpack|chunk|bundle|module|__webpack|__dirname|__filename)/i,
  frameworks: /^(react|vue|angular|component|props|state|redux|store|dispatch|action)$/i,
  libraries: /^(jquery|\$|lodash|_|axios|fetch|xhr|request)$/i,
  domEvents: /^(event|target|currentTarget|preventDefault|key|keyCode|which|button|click)$/i,
  generic: /^(data|obj|item|value|result|response|config|options|settings|params)$/i,
  singleChar: /^[a-z]$/i,
  filePaths:
    /(node_modules|dist|build|static|\.js|\.css|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.ico|\.woff|\.ttf|\.eot)/i,
  commonParams: /^(page|limit|offset|sort|order|filter|search|q|query)$/i,
  telemetry: /^(visitId|analytics|trace|metric|hcaptchaToken|x-sentry-.*)$/i,
  standardHeaders:
    /^(content-type|accept|user-agent|accept-language|accept-encoding|connection|cache-control|host|origin|referer|referrer)$/i,
  genericWrapper: /^(index|data|value|prefill|members)$/i,
};

const TYPE_HINTS = [
  /^(userId|user_id|userID|uid)$/i,
  /^(email|emailAddress|email_address)$/i,
  /^(token|apiKey|api_key|apikey|accessToken|access_token)$/i,
  /^(password|pwd|pass|passwd)$/i,
  /^(id|.*Id|.*_id|.*ID)$/i,
];

interface ParamContext {
  method: string;
  hasExplicitAPICall: boolean;
  isAPIContext: boolean;
  context?: string;
}

function isHighRiskParameter(paramName: string): boolean {
  return Object.values(HIGH_RISK_PATTERNS).some((p) => p.test(paramName));
}

function shouldSuppress(paramName: string, ctx: ParamContext, location = 'body'): boolean {
  for (const [category, pattern] of Object.entries(SUPPRESSION_PATTERNS)) {
    if (pattern.test(paramName)) {
      if (category === 'generic' && ctx.hasExplicitAPICall) return false;
      if (category === 'standardHeaders' && location !== 'header') continue;
      if (category === 'commonParams' && !isHighRiskParameter(paramName)) return true;
      if (category !== 'generic') return true;
    }
  }
  if (!ctx.isAPIContext) return true;
  if (paramName.length === 1 && !isHighRiskParameter(paramName)) return true;
  return false;
}

function referencesComplexObjects(paramName: string, context?: string): boolean {
  if (!context) return false;
  const s = context.toLowerCase();
  if (s.includes('document.') || s.includes('window.') || s.includes('queryselector')) return true;
  if (s.includes('addeventlistener') || s.includes('onclick') || s.match(/\bevent\b/)) return true;
  if (s.includes('function(') || s.includes('=>') || s.includes('symbol(') || s.includes('typeof'))
    return true;
  return false;
}

function hasTypeHint(paramName: string): boolean {
  return TYPE_HINTS.some((p) => p.test(paramName));
}

function getRiskLevel(paramName: string): ParameterHit['riskLevel'] {
  if (
    HIGH_RISK_PATTERNS.auth.test(paramName) ||
    HIGH_RISK_PATTERNS.access.test(paramName) ||
    HIGH_RISK_PATTERNS.flags.test(paramName)
  ) {
    return 'high';
  }
  if (HIGH_RISK_PATTERNS.idor.test(paramName) || HIGH_RISK_PATTERNS.features.test(paramName)) {
    return 'medium';
  }
  return 'low';
}

function detectAPIContext(content: string, matchIndex: number): ParamContext {
  const s = content
    .substring(Math.max(0, matchIndex - 200), Math.min(content.length, matchIndex + 200))
    .toLowerCase();
  const hasExplicitAPICall =
    /(fetch|axios|xmlhttprequest|xhr\.|\.get\(|\.post\(|\.put\(|\.patch\(|\.delete\()/.test(s);
  const isAPIContext =
    hasExplicitAPICall || s.includes('api') || s.includes('endpoint') || s.includes('request');
  let method = 'GET';
  if (s.includes('post')) method = 'POST';
  else if (s.includes('put')) method = 'PUT';
  else if (s.includes('patch')) method = 'PATCH';
  else if (s.includes('delete')) method = 'DELETE';
  return { method, hasExplicitAPICall, isAPIContext };
}

function calculateParamConfidence(
  param: ParameterHit,
  ctx: ParamContext,
  hasEndpoint: boolean,
): number {
  let confidence = 50;
  if (isHighRiskParameter(param.name)) {
    if (hasEndpoint) confidence += 25;
    else return Math.min(40, confidence);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) confidence += 20;
  if (ctx.hasExplicitAPICall) confidence += 15;
  if (hasTypeHint(param.name)) confidence += 10;
  if (param.location === 'body') confidence += 10;
  else if (param.location === 'query') confidence += 5;
  else if (param.location === 'header') confidence += 15;
  if (param.name.length < 3) confidence -= 20;
  if (param.name.length > 30) confidence -= 10;
  if (!hasEndpoint && !isHighRiskParameter(param.name)) confidence = Math.min(40, confidence);
  return Math.min(100, Math.max(0, confidence));
}

const CONFIG_PROPERTIES = new Set([
  'method',
  'headers',
  'credentials',
  'mode',
  'cache',
  'redirect',
  'referrer',
  'referrerPolicy',
  'integrity',
  'keepalive',
  'signal',
  'timeout',
  'validateStatus',
  'responseType',
  'withCredentials',
  'params',
  'data',
  'body',
]);

const STANDARD_HEADERS = new Set([
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'accept-encoding',
  'user-agent',
  'referer',
  'origin',
  'cache-control',
  'connection',
  'host',
  'cookie',
]);

function collectNamedKeys(
  objBody: string,
  pattern: RegExp,
  location: ParameterHit['location'],
  content: string,
  matchIndex: number,
  matchLen: number,
  seen: Set<string>,
  out: ParameterHit[],
  exclude?: Set<string>,
): void {
  const keyMatches = objBody.match(pattern);
  if (!keyMatches) return;
  for (const keyMatch of keyMatches) {
    const name = keyMatch.replace(/["':]/g, '').trim();
    if (!name) continue;
    if (exclude?.has(name.toLowerCase())) continue;
    const key = `${location}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      location,
      context: content.substring(
        Math.max(0, matchIndex - 50),
        Math.min(content.length, matchIndex + matchLen + 50),
      ),
      riskLevel: getRiskLevel(name),
      confidence: 0,
    });
  }
}

function extractQueryParameters(content: string): ParameterHit[] {
  const params: ParameterHit[] = [];
  const seen = new Set<string>();

  const queryPattern1 = /["'`]([^"'`]*\?([a-zA-Z_][a-zA-Z0-9_-]{1,49})=[^"'`&]*)["'`]/g;
  for (const match of content.matchAll(queryPattern1)) {
    const names = match[1].match(/([a-zA-Z_][a-zA-Z0-9_-]{1,49})=/g);
    if (names) {
      for (const n of names) {
        const name = n.replace('=', '').trim();
        if (name && !seen.has(`query:${name}`)) {
          seen.add(`query:${name}`);
          params.push({
            name,
            location: 'query',
            context: content.substring(
              Math.max(0, match.index - 50),
              Math.min(content.length, match.index + match[0].length + 50),
            ),
            riskLevel: getRiskLevel(name),
            confidence: 0,
          });
        }
      }
    }
  }

  const urlSearchParamsPattern = /(?:new\s+)?URLSearchParams\s*[({]\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(urlSearchParamsPattern)) {
    collectNamedKeys(
      match[1],
      /([a-zA-Z_][a-zA-Z0-9_-]{1,49})\s*:/g,
      'query',
      content,
      match.index,
      match[0].length,
      seen,
      params,
    );
  }

  const axiosParamsPattern = /params\s*:\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(axiosParamsPattern)) {
    collectNamedKeys(
      match[1],
      /([a-zA-Z_][a-zA-Z0-9_-]{1,49})\s*:/g,
      'query',
      content,
      match.index,
      match[0].length,
      seen,
      params,
    );
  }

  return params;
}

function extractBodyParameters(content: string): ParameterHit[] {
  const params: ParameterHit[] = [];
  const seen = new Set<string>();

  const jsonStringifyPattern = /JSON\.stringify\s*\(\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(jsonStringifyPattern)) {
    collectNamedKeys(
      match[1],
      /([a-zA-Z_$][a-zA-Z0-9_$-]{1,49})\s*:/g,
      'body',
      content,
      match.index,
      match[0].length,
      seen,
      params,
      CONFIG_PROPERTIES,
    );
  }

  const axiosDataPattern = /axios\.(?:post|put|patch|delete)\s*\(\s*[^,]+,\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(axiosDataPattern)) {
    collectNamedKeys(
      match[1],
      /([a-zA-Z_$][a-zA-Z0-9_$-]{1,49})\s*:/g,
      'body',
      content,
      match.index,
      match[0].length,
      seen,
      params,
      CONFIG_PROPERTIES,
    );
  }

  const fetchBodyObjectPattern = /(?:fetch|axios)\s*\([^,]+,\s*\{[^}]*body\s*:\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(fetchBodyObjectPattern)) {
    collectNamedKeys(
      match[1],
      /([a-zA-Z_$][a-zA-Z0-9_$-]{1,49})\s*:/g,
      'body',
      content,
      match.index,
      match[0].length,
      seen,
      params,
      CONFIG_PROPERTIES,
    );
  }

  const formDataPattern = /\.append\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_-]{1,49})["']/g;
  for (const match of content.matchAll(formDataPattern)) {
    const name = match[1];
    if (!seen.has(`body:${name}`)) {
      seen.add(`body:${name}`);
      params.push({
        name,
        location: 'body',
        context: content.substring(
          Math.max(0, match.index - 50),
          Math.min(content.length, match.index + match[0].length + 50),
        ),
        riskLevel: getRiskLevel(name),
        confidence: 0,
      });
    }
  }

  return params;
}

function extractHeaderParameters(content: string): ParameterHit[] {
  const params: ParameterHit[] = [];
  const seen = new Set<string>();
  const headersPattern = /headers\s*:\s*\{([^}]+)\}/g;
  for (const match of content.matchAll(headersPattern)) {
    const headerMatches = match[1].match(/(?:["'])?([a-zA-Z][a-zA-Z0-9_-]{1,49})(?:["'])?\s*:/g);
    if (!headerMatches) continue;
    for (const h of headerMatches) {
      const name = h.replace(/["']/g, '').replace(':', '').trim().toLowerCase();
      if (
        (name.startsWith('x-') || name === 'authorization') &&
        !STANDARD_HEADERS.has(name) &&
        !seen.has(`header:${name}`)
      ) {
        seen.add(`header:${name}`);
        params.push({
          name,
          location: 'header',
          context: content.substring(
            Math.max(0, match.index - 50),
            Math.min(content.length, match.index + match[0].length + 50),
          ),
          riskLevel: getRiskLevel(name),
          confidence: 0,
        });
      }
    }
  }
  return params;
}

function extractPathParameters(content: string): ParameterHit[] {
  const params: ParameterHit[] = [];
  const seen = new Set<string>();
  const pathParamPattern = /\$\{([a-zA-Z_][a-zA-Z0-9_]{1,49})\}/g;
  for (const match of content.matchAll(pathParamPattern)) {
    const name = match[1];
    const before = content.substring(Math.max(0, match.index - 100), match.index);
    const after = content.substring(
      match.index + match[0].length,
      Math.min(content.length, match.index + match[0].length + 100),
    );
    if (
      (before.includes('/') ||
        before.includes('api') ||
        before.includes('fetch') ||
        before.includes('axios')) &&
      !seen.has(`path:${name}`)
    ) {
      seen.add(`path:${name}`);
      params.push({
        name,
        location: 'path',
        context: before + match[0] + after,
        riskLevel: getRiskLevel(name),
        confidence: 0,
      });
    }
  }
  return params;
}

export function extractParameters(content: string, endpointHints?: string[]): ParameterHit[] {
  if (!content) return [];
  const raw = [
    ...extractQueryParameters(content),
    ...extractBodyParameters(content),
    ...extractHeaderParameters(content),
    ...extractPathParameters(content),
  ];
  const hasEndpoint = Boolean(endpointHints && endpointHints.length > 0);
  const results: ParameterHit[] = [];
  const seen = new Set<string>();
  for (const param of raw) {
    const key = `${param.location}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ctx = detectAPIContext(content, 0);
    if (shouldSuppress(param.name, ctx, param.location)) continue;
    if (referencesComplexObjects(param.name, param.context)) continue;
    param.confidence = calculateParamConfidence(param, ctx, hasEndpoint);
    results.push(param);
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
