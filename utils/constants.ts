// Default configuration values
export const DEFAULT_TRUNCATION_LIMIT = 2000;

// Hardcoded Groq defaults so the extension works out of the box.
export const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const GROQ_API_KEY = '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';
export const GROQ_MAX_TOKENS = 65536;

// Security tools (rep+ inspired)
export const MAX_CAPTURED_REQUESTS = 200;
export const MAX_CAPTURE_BODY_BYTES = 65536;
