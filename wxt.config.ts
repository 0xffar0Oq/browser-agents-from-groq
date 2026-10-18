import { defineConfig } from 'wxt';

export default defineConfig({
  webExt: {
    firefoxPrefs: { 'datareporting.policy.firstRunURL': '' },
  },
  vite: () => ({
    base: './',
    server: {
      port: 3000,
    },
    publicDir: 'public',
  }),
  manifest: ({ browser }) => ({
    name: 'LLM Actions+ (Groq)',
    description:
      'Browser agent with Groq LLM: page automation, security recon tools, and TradingView trading helpers',
    permissions: [
      'storage',
      'activeTab',
      'tabs',
      'webRequest',
      ...(browser === 'chrome' ? ['sidePanel'] : []),
    ],
    host_permissions: [
      'http://localhost:*/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
      'https://api.groq.com/*',
      'https://openrouter.ai/*',
      'https://*.tradingview.com/*',
      '*://*/*',
    ],
    web_accessible_resources: [
      {
        resources: ['tv-sniffer.js'],
        matches: ['*://*/*'],
      },
    ],
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    // Chrome sidepanel
    ...(browser === 'chrome'
      ? {
          side_panel: {
            default_path: 'sidepanel.html',
          },
        }
      : {}),
    // Firefox sidebar and background
    ...(browser === 'firefox'
      ? {
          sidebar_action: {
            default_title: 'LLM Chat',
            default_panel: 'sidepanel.html',
            default_icon: {
              16: 'icons/icon-16.png',
              48: 'icons/icon-48.png',
              128: 'icons/icon-128.png',
            },
          },
        }
      : {}),
  }),
});
