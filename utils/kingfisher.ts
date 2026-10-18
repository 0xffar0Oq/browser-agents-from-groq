// Kingfisher secret-detection rules engine (TS port of rep+ kingfisher-rules.js
// + secrets.js false-positive filtering). Rules are bundled as JSON converted
// from the upstream Kingfisher YAML rule set.

import browser from 'webextension-polyfill';

export interface KingfisherRule {
  id?: string;
  name?: string;
  pattern: string;
  min_entropy?: number;
  confidence?: string;
  pattern_requirements?: {
    min_digits?: number;
    ignore_if_contains?: string[];
    [key: string]: unknown;
  };
  compiledRegex?: RegExp;
  cleanedPattern?: string;
}

export interface KingfisherHit {
  ruleId?: string;
  ruleName?: string;
  match: string;
  index: number;
  confidence: string;
  entropy: string;
  file: string;
}

const KNOWN_FALSE_POSITIVE_PATTERNS = [
  /^[a-f0-9]{40}$/i,
  /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/,
  /^[a-z][a-zA-Z0-9]+(?:[A-Z][a-z0-9]+)+$/,
  /^(?:map|filter|reduce|forEach|slice|splice|concat)/i,
  /^_react|_emotion|_styled|_next/i,
  /sourceMappingURL/i,
  /^__webpack/i,
  /^module\./i,
  /^exports\./i,
];

const FALSE_POSITIVE_CONTEXT_PATTERNS = [
  /base64,/i,
  /data:image/i,
  /;base64/i,
  /"(?:publicKey|privateKey|data|content|image|icon|font|logo|avatar|thumbnail|media|src|href)":/i,
  /iVBOR|AAAA|\/png|\/jpeg|\/jpg|\/gif|\/webp|\/svg/i,
  /sourceMappingURL=/i,
  /webpack:\/\//i,
  /__webpack/i,
  /\.chunk\.js/i,
  /\/\*#\s*source/i,
  /import\s+.*\s+from\s+['"]/i,
  /require\s*\(['"]/i,
  /["']data["']\s*:/i,
  /["']image["']\s*:/i,
  /\/\/ data:image/i,
];

export function getEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isLikelyBase64Data(str: string, context: string): boolean {
  if (/data:[\w/-]+;base64,/.test(context)) return true;
  if (/={1,2}$/.test(str) && str.length > 100) return true;
  if (str.length > 200 && /^[A-Za-z0-9+/=]+$/.test(str)) return true;
  const beforeContext = context.substring(0, 100);
  if (
    /"(?:data|content|image|icon|font|media|src|href|asset|resource)"\s*:\s*"[^"]*$/i.test(
      beforeContext,
    )
  ) {
    return true;
  }
  if (
    /(?:const|let|var)\s+(?:data|image|icon|font|asset|resource|content)\w*\s*=\s*["`'][^"`']*$/i.test(
      beforeContext,
    )
  ) {
    return true;
  }
  return false;
}

function isInComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function validatePatternRequirements(
  match: string,
  requirements: NonNullable<KingfisherRule['pattern_requirements']>,
): boolean {
  if (typeof requirements.min_digits === 'number') {
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount < requirements.min_digits) return false;
  }
  if (Array.isArray(requirements.ignore_if_contains)) {
    for (const needle of requirements.ignore_if_contains) {
      if (match.includes(needle)) return false;
    }
  }
  return true;
}

// Strip comments from (?x) extended-mode patterns.
function stripComments(pattern: string, isExtendedMode: boolean): string {
  if (!isExtendedMode) return pattern;
  let result = '';
  let inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      result += ch;
      if (i + 1 < pattern.length) {
        result += pattern[i + 1];
        i++;
      }
      continue;
    }
    if (ch === '[') inCharClass = true;
    if (ch === ']') inCharClass = false;
    if (!inCharClass && ch === '#') {
      while (i < pattern.length && pattern[i] !== '\n') i++;
      continue;
    }
    result += ch;
  }
  // In extended mode whitespace outside char classes is insignificant.
  if (!inCharClass) {
    result = result.replace(/[\t ]+/g, '');
  }
  return result;
}

function convertPatternFlags(pattern: string): { pattern: string; flags: string } {
  let flags = 'g';
  let body = pattern;
  const inline = /^\(\?([imsux]+)\)/.exec(body);
  if (inline) {
    const opts = inline[1];
    body = body.slice(inline[0].length);
    if (opts.includes('i')) flags += 'i';
    if (opts.includes('m')) flags += 'm';
    if (opts.includes('s')) flags += 's';
    // 'x' handled via stripComments, 'u' rarely needed for JS RegExp.
  }
  return { pattern: body, flags };
}

function compileRule(rule: KingfisherRule): KingfisherRule | null {
  if (!rule?.pattern) return null;
  const hasExtendedFlag =
    /^\(\?([imsux]+)\)/.test(rule.pattern) &&
    /^\(\?([imsux]+)\)/.exec(rule.pattern)?.[1]?.includes('x');
  const cleaned = stripComments(rule.pattern, Boolean(hasExtendedFlag));
  const { pattern, flags } = convertPatternFlags(cleaned);
  try {
    const regex = new RegExp(pattern, flags);
    return { ...rule, compiledRegex: regex, cleanedPattern: pattern };
  } catch {
    return null;
  }
}

let compiledCache: KingfisherRule[] | null = null;

export async function loadKingfisherRules(): Promise<KingfisherRule[]> {
  if (compiledCache) return compiledCache;
  try {
    const url = browser.runtime.getURL('kingfisher-rules.json');
    const response = await fetch(url);
    const parsed = (await response.json()) as { rules?: KingfisherRule[] } | KingfisherRule[];
    const rules = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
    compiledCache = rules.map(compileRule).filter((r): r is KingfisherRule => r !== null);
  } catch (error) {
    compiledCache = [];
  }
  return compiledCache;
}

export async function scanContentForSecrets(
  content: string,
  file: string,
): Promise<KingfisherHit[]> {
  const results: KingfisherHit[] = [];
  if (!content) return results;

  const rules = await loadKingfisherRules();
  if (rules.length === 0) return results;

  for (const rule of rules) {
    if (!rule.compiledRegex) continue;
    try {
      const regex = rule.compiledRegex;
      regex.lastIndex = 0;
      for (const match of content.matchAll(regex)) {
        const matchedStr = match[0];
        if (matchedStr.length === 0) {
          regex.lastIndex++;
          continue;
        }

        if (rule.min_entropy && getEntropy(matchedStr) < rule.min_entropy) continue;
        if (
          rule.pattern_requirements &&
          !validatePatternRequirements(matchedStr, rule.pattern_requirements)
        ) {
          continue;
        }

        const contextStart = Math.max(0, match.index - 100);
        const contextEnd = Math.min(content.length, match.index + matchedStr.length + 100);
        const context = content.substring(contextStart, contextEnd);

        if (KNOWN_FALSE_POSITIVE_PATTERNS.some((p) => p.test(matchedStr))) continue;
        if (FALSE_POSITIVE_CONTEXT_PATTERNS.some((p) => p.test(context))) continue;
        if (isLikelyBase64Data(matchedStr, context)) continue;

        const lineStart = content.lastIndexOf('\n', match.index) + 1;
        const lineEnd = content.indexOf('\n', match.index);
        const line = content.substring(lineStart, lineEnd === -1 ? content.length : lineEnd);
        if (isInComment(line)) continue;

        let confidenceScore = 50;
        if (rule.confidence === 'high') confidenceScore = 85;
        else if (rule.confidence === 'medium') confidenceScore = 70;
        else confidenceScore = 60;
        const entropy = getEntropy(matchedStr);
        if (entropy > 4.5) confidenceScore += 10;
        else if (entropy < 3.5) confidenceScore -= 10;
        if (confidenceScore < 60) continue;

        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          match: matchedStr,
          index: match.index,
          confidence: rule.confidence || 'medium',
          entropy: entropy.toFixed(2),
          file,
        });
      }
    } catch {
      // Skip rules that throw at runtime.
    }
  }
  return results;
}
