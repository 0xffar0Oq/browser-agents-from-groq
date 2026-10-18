// Content-script page functions dispatched from content.ts.
// Script discovery for the security scanners, plus TradingView tools.

import browser from 'webextension-polyfill';
import { contentLogger } from './debug-logger';

// ---------------------------------------------------------------------------
// Latest sniffed TradingView tick (posted by public/tv-sniffer.js, MAIN world)
// ---------------------------------------------------------------------------

interface TvTick {
  symbol?: string | null;
  last?: number | null;
  prevClose?: number | null;
  change?: number | null;
  changePercent?: number | null;
  high?: number | null;
  low?: number | null;
  open?: number | null;
  time?: number;
}

let latestTick: TvTick | null = null;
let snifferInstalled = false;

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; tick?: TvTick } | undefined;
  if (data && data.source === 'LLM-TV-SNIFFER' && data.tick) {
    latestTick = data.tick;
  }
});

function ensureSnifferInstalled(): void {
  if (snifferInstalled) return;
  if (!/^https?:\/\/([^.]+\.)?tradingview\.com$/.test(window.location.origin)) return;
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('tv-sniffer.js');
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    snifferInstalled = true;
  } catch (error) {
    contentLogger.debug('Failed to install TV sniffer', { error });
  }
}

// ---------------------------------------------------------------------------
// Generic DOM helpers
// ---------------------------------------------------------------------------

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function walkVisible(matcher: (el: Element) => boolean, limit = 50): Element | null {
  const all = document.querySelectorAll('body *');
  let count = 0;
  for (const el of all) {
    if (++count > 8000) break;
    if (!isVisible(el)) continue;
    if (matcher(el)) return el;
  }
  return null;
}

function findButtonsByText(texts: string[]): HTMLElement[] {
  const wanted = texts.map((t) => t.trim().toLowerCase());
  const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"], .tv-button');
  const out: HTMLElement[] = [];
  for (const b of buttons) {
    if (!isVisible(b)) continue;
    const text = (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
    if (!text) continue;
    if (wanted.some((w) => text === w || text.startsWith(w) || text.includes(w))) out.push(b);
  }
  return out;
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

function parseAmount(text: string): number | null {
  const m = text.replace(/\s/g, '').match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Page script discovery
// ---------------------------------------------------------------------------

function getPageScriptUrls(): string[] {
  const urls = new Set<string>();
  for (const s of Array.from(document.scripts)) {
    if (s.src) urls.add(s.src);
  }
  // modulepreload / preload links
  for (const link of Array.from(
    document.querySelectorAll<HTMLLinkElement>(
      'link[rel="modulepreload"], link[rel="preload"][as="script"]',
    ),
  )) {
    if (link.href) urls.add(link.href);
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// TradingView helpers
// ---------------------------------------------------------------------------

function isTradingView(): boolean {
  return /(^|\.)tradingview\.com$/.test(window.location.hostname);
}

function readLegend(): { symbol?: string; title?: string } {
  const out: { symbol?: string; title?: string } = {};
  const titleEl =
    document.querySelector('[data-name="legend-source-title"]') ||
    document.querySelector('.chart-markup-table .title') ||
    document.querySelector('[class*="legend"] [class*="title"]');
  if (titleEl?.textContent) out.title = titleEl.textContent.trim();
  out.symbol = document.title.replace(/\s*[-–|]\s*TradingView.*$/i, '').trim() || undefined;
  return out;
}

function readDomPrice(): { last?: number; change?: number; changePercent?: number } {
  const out: { last?: number; change?: number; changePercent?: number } = {};
  const lastEl =
    document.querySelector('[data-name="legend-last-value"]') ||
    walkVisible((el) => {
      const name = el.getAttribute?.('data-name') || '';
      return name === 'legend-last-value';
    });
  if (lastEl?.textContent) out.last = parseAmount(lastEl.textContent) ?? undefined;

  const changeEl =
    document.querySelector('[data-name="legend-change"]') ||
    document.querySelector('[data-name="legend-change-percent"]');
  if (changeEl?.textContent) {
    const text = changeEl.textContent;
    const amount = text.match(/\(?(-?[\d.,]+)\)?/);
    if (amount) out.change = parseAmount(amount[1]) ?? undefined;
    const pct = text.match(/(-?[\d.,]+)\s*%/);
    if (pct) out.changePercent = parseAmount(pct[1]) ?? undefined;
  }
  return out;
}

function findTicketContainer(): Element | null {
  return (
    document.querySelector('[data-name="order-panel"]') ||
    document.querySelector('[data-name="order-ticket"]') ||
    document.querySelector('[data-name="order-dialog"]') ||
    document.querySelector('[class*="orderPanel"]') ||
    document.querySelector('[class*="order-ticket"]') ||
    walkVisible((el) => {
      const t = (el.textContent || '').toLowerCase();
      return (
        t.includes('order ticket') ||
        (t.includes('quantity') && t.includes('buy') && t.includes('sell') && t.length < 4000)
      );
    })
  );
}

interface TicketField {
  name: string;
  label: string;
  value: string;
  selector: string;
}

function collectTicketFields(ticket: Element): TicketField[] {
  const fields: TicketField[] = [];
  const inputs = ticket.querySelectorAll<HTMLInputElement>('input, [contenteditable="true"]');
  let i = 0;
  for (const input of inputs) {
    if (!isVisible(input)) continue;
    const label =
      input.getAttribute('aria-label') ||
      input.getAttribute('name') ||
      input.getAttribute('placeholder') ||
      input.dataset?.name ||
      '';
    fields.push({
      name: `field_${i++}`,
      label: label.trim(),
      value: input.value ?? '',
      selector: label.trim() || `field_${i}`,
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// TradingView tool implementations
// ---------------------------------------------------------------------------

export interface TvMarketInfo {
  isTradingView: boolean;
  pageUrl: string;
  symbol?: string;
  title?: string;
  lastPrice?: number;
  change?: number;
  changePercent?: number;
  high?: number;
  low?: number;
  open?: number;
  source: 'websocket' | 'dom' | 'unavailable';
}

function tvMarketInfo(): TvMarketInfo {
  ensureSnifferInstalled();
  const legend = readLegend();
  const dom = readDomPrice();
  const out: TvMarketInfo = {
    isTradingView: isTradingView(),
    pageUrl: window.location.href,
    symbol: latestTick?.symbol || legend.symbol,
    title: legend.title,
    source: 'unavailable',
  };

  if (latestTick && typeof latestTick.last === 'number') {
    out.lastPrice = latestTick.last;
    out.change = latestTick.change ?? undefined;
    out.changePercent = latestTick.changePercent ?? undefined;
    out.high = latestTick.high ?? undefined;
    out.low = latestTick.low ?? undefined;
    out.open = latestTick.open ?? undefined;
    out.source = 'websocket';
  } else if (typeof dom.last === 'number') {
    out.lastPrice = dom.last;
    out.change = dom.change;
    out.changePercent = dom.changePercent;
    out.source = 'dom';
  } else if (typeof latestTick?.change === 'number' || typeof dom.change === 'number') {
    out.change = latestTick?.change ?? dom.change;
    out.changePercent = latestTick?.changePercent ?? dom.changePercent;
    out.source = 'websocket';
  }
  return out;
}

export interface TvTicketState {
  found: boolean;
  container?: string;
  side?: string;
  fields: TicketField[];
  candidateSideButtons: string[];
}

function tvTicketState(): TvTicketState {
  const ticket = findTicketContainer();
  if (!ticket) {
    return {
      found: false,
      fields: [],
      candidateSideButtons: findButtonsByText(['buy', 'sell']).map((b) =>
        (b.textContent || '').trim().slice(0, 60),
      ),
    };
  }
  const buttons = findButtonsByText([
    'buy',
    'sell',
    'buy limit',
    'sell limit',
    'buy stop',
    'sell stop',
    'buy stop limit',
    'sell stop limit',
  ]).filter((b) => ticket.contains(b));
  const fields = collectTicketFields(ticket);
  let side: string | undefined;
  for (const b of buttons) {
    const label = (b.textContent || '').trim();
    const pressed =
      b.getAttribute('aria-pressed') === 'true' ||
      b.getAttribute('aria-checked') === 'true' ||
      b.className.includes('active') ||
      b.className.includes('selected') ||
      b.className.includes('isJailed') ||
      b.className.includes('checked');
    if (pressed) side = label;
  }
  return {
    found: true,
    container: ticket.getAttribute('data-name') || ticket.className.toString().slice(0, 80),
    side,
    fields,
    candidateSideButtons: buttons.map((b) => (b.textContent || '').trim()),
  };
}

export interface TvPlaceOrderArgs {
  side: string;
  quantity: string;
  orderType?: string;
  limitPrice?: string;
  stopPrice?: string;
  confirm?: boolean;
}

export interface TvPlaceOrderResult {
  status: 'preview' | 'submitted' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

function findFieldByLabel(ticket: Element, patterns: RegExp): HTMLInputElement | null {
  const inputs = ticket.querySelectorAll<HTMLInputElement>('input, [contenteditable="true"]');
  for (const input of inputs) {
    if (!isVisible(input)) continue;
    const label = [
      input.getAttribute('aria-label'),
      input.getAttribute('name'),
      input.getAttribute('placeholder'),
      input.dataset?.name,
      input.getAttribute('title'),
    ]
      .filter(Boolean)
      .join(' ');
    if (patterns.test(label)) return input;
  }
  return null;
}

function tvPlaceOrder(args: TvPlaceOrderArgs): TvPlaceOrderResult {
  const side = (args.side || '').trim().toLowerCase();
  const quantity = (args.quantity || '').trim();
  const orderType = (args.orderType || 'market').trim().toLowerCase();

  if (!['buy', 'sell'].includes(side)) {
    return { status: 'error', message: `side must be "buy" or "sell", got "${args.side}"` };
  }
  const qtyNum = Number.parseFloat(quantity.replace(/,/g, ''));
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    return {
      status: 'error',
      message: `quantity must be a positive number, got "${args.quantity}"`,
    };
  }

  const ticket = findTicketContainer();
  if (!ticket) {
    return {
      status: 'error',
      message:
        'Order ticket not found on the page. Open the TradingView order panel (trade panel / order ticket) first.',
    };
  }

  // Side button: exact-ish match preferring the requested side + order type.
  const desiredLabels =
    orderType === 'market'
      ? [side, `${side} market`]
      : [`${side} ${orderType}`, side, `${side} market`];
  const allSideButtons = findButtonsByText(desiredLabels).filter((b) => ticket.contains(b));
  if (allSideButtons.length === 0) {
    return {
      status: 'error',
      message: `Could not find a "${side}" button inside the order ticket. Ticket labels: ${tvTicketState().candidateSideButtons.join(
        ', ',
      )}`,
    };
  }
  const sideButton = allSideButtons[0];
  const sideLabel = (sideButton.textContent || '').trim();

  const qtyInput = findFieldByLabel(ticket, /qty|quantity|amount|units|size/i);
  const priceInput =
    orderType === 'market'
      ? null
      : findFieldByLabel(ticket, /price|limit|stop/i) || findFieldByLabel(ticket, /price/i);

  const plan = {
    page: window.location.href,
    symbol: readLegend().symbol || document.title,
    side: sideLabel,
    quantity,
    orderType,
    limitPrice: args.limitPrice,
    stopPrice: args.stopPrice,
    willFillPriceField: Boolean(priceInput && (args.limitPrice || args.stopPrice)),
    willSubmit: Boolean(args.confirm),
  };

  if (!args.confirm) {
    return {
      status: 'preview',
      message:
        'Preview only — confirm was not set. Review the plan and re-call tv_place_order with confirm=true to submit.',
      details: plan,
    };
  }

  try {
    sideButton.click();
    if (!qtyInput) {
      return {
        status: 'error',
        message: 'Quantity input not found in the order ticket — nothing was submitted.',
        details: plan,
      };
    }
    setInputValue(qtyInput, quantity);

    const priceToSet = args.limitPrice || args.stopPrice;
    if (priceInput && priceToSet) setInputValue(priceInput, priceToSet);

    // Final submit: primary action button repeating the side label.
    const submitButtons = findButtonsByText([side]).filter(
      (b) => ticket.contains(b) && b !== sideButton && isVisible(b),
    );
    const submit =
      submitButtons.find((b) => {
        const cls = b.className.toString().toLowerCase();
        return cls.includes('submit') || cls.includes('buy') || cls.includes('sell');
      }) || submitButtons[0];

    if (submit) {
      submit.click();
      return {
        status: 'submitted',
        message: `Order submitted: ${sideLabel} ${quantity} (${orderType}). Verify it in your positions/orders.`,
        details: plan,
      };
    }
    return {
      status: 'error',
      message:
        'Filled the ticket but could not find a final submit button — order was NOT submitted. Confirm the ticket state manually.',
      details: plan,
    };
  } catch (error) {
    return {
      status: 'error',
      message: `Order placement failed: ${error instanceof Error ? error.message : String(error)}`,
      details: plan,
    };
  }
}

export interface TvPosition {
  raw: Record<string, string>;
  symbol?: string;
  side?: string;
  quantity?: number;
  averagePrice?: number;
  unrealizedPnl?: number;
}

function tvOpenPositions(): { found: boolean; positions: TvPosition[]; note?: string } {
  ensureSnifferInstalled();
  const positions: TvPosition[] = [];

  const containers = [
    ...document.querySelectorAll(
      '[data-name="positions"], [data-name="position"], [data-name="open-positions"], [class*="positionsTable"], [class*="PositionsTable"]',
    ),
  ];

  const rows = new Set<Element>();
  for (const c of containers) {
    for (const tr of c.querySelectorAll('tr')) rows.add(tr);
    // TradingView often uses div-based rows
    for (const row of c.querySelectorAll('[role="row"]')) rows.add(row);
  }
  if (rows.size === 0) {
    // Fallback: any table/row group whose header mentions Symbol & Side
    for (const table of document.querySelectorAll('table, [role="table"]')) {
      const head = (table.textContent || '').slice(0, 500).toLowerCase();
      if (
        head.includes('symbol') &&
        (head.includes('side') || head.includes('qty') || head.includes('p&l'))
      ) {
        for (const tr of table.querySelectorAll('tr, [role="row"]')) rows.add(tr);
      }
    }
  }

  for (const row of rows) {
    if (!isVisible(row)) continue;
    const cells = Array.from(row.querySelectorAll('td, [role="cell"], [role="gridcell"]'));
    if (cells.length < 2) continue;
    const raw: Record<string, string> = {};
    const values: string[] = [];
    cells.forEach((cell, idx) => {
      const text = (cell.textContent || '').trim();
      values.push(text);
      raw[`col_${idx}`] = text;
    });
    const joined = values.join(' | ');
    if (/symbol/i.test(joined) && /side|qty/i.test(joined)) continue; // header row
    const pos: TvPosition = { raw };
    const symbolCandidate = values.find(
      (v) => /^[A-Z0-9.]{2,20}$/.test(v) && /\d/.test(v) === false && v.length >= 2,
    );
    if (symbolCandidate) pos.symbol = symbolCandidate;
    const sideCell = values.find((v) => /^(long|short|buy|sell)$/i.test(v));
    if (sideCell) pos.side = sideCell.toLowerCase();
    for (const v of values) {
      const n = parseAmount(v);
      if (n === null) continue;
      if (pos.quantity === undefined && Number.isInteger(n) && Math.abs(n) <= 100000)
        pos.quantity = n;
      else if (pos.averagePrice === undefined && v.includes('.') && Math.abs(n) < 1e9)
        pos.averagePrice = n;
      else if (v.startsWith('+') || v.startsWith('-')) pos.unrealizedPnl = n;
    }
    if (Object.keys(raw).length >= 2) positions.push(pos);
  }

  return positions.length > 0
    ? { found: true, positions }
    : {
        found: false,
        positions: [],
        note: 'No positions table found. The trade/positions panel may be closed, or there are no open positions.',
      };
}

export interface TvBalance {
  found: boolean;
  balance?: number;
  equity?: number;
  buyingPower?: number;
  currency?: string;
  matches: Array<{ label: string; value: number }>;
}

function tvDetectBalance(): TvBalance {
  const matches: Array<{ label: string; value: number }> = [];
  const labelRe =
    /\b(balance|equity|buying power|purchasing power|account value|total value|cash|margin available)\b/gi;
  const text = document.body.innerText.slice(0, 300_000);
  for (const m of text.matchAll(labelRe)) {
    const slice = text.slice(m.index, m.index + 120);
    const valueMatch = slice.match(
      /[:\s]\s*\$?\s*(-?[\d]{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)/,
    );
    if (!valueMatch) continue;
    const value = parseAmount(valueMatch[1]);
    if (value === null || value <= 0) continue;
    const label = m[1].toLowerCase();
    if (matches.some((x) => x.label === label && x.value === value)) continue;
    matches.push({ label, value });
  }
  const out: TvBalance = { found: matches.length > 0, matches };
  const get = (label: string) => matches.find((x) => x.label === label)?.value;
  out.balance = get('balance') ?? get('account value') ?? get('cash');
  out.equity = get('equity') ?? get('total value');
  out.buyingPower = get('buying power') ?? get('purchasing power') ?? get('margin available');
  const currencyMatch = text.match(/\b(USD|EUR|BRL|GBP|JPY|USDT?)\b/);
  if (currencyMatch) out.currency = currencyMatch[1];
  return out;
}

export interface TvPositionSizeArgs {
  balance?: number;
  riskPercent: number;
  entryPrice: number;
  stopPercent: number;
  pointValue?: number;
  step?: number;
}

function tvPositionSize(args: TvPositionSizeArgs): Record<string, unknown> {
  const step = args.step && args.step > 0 ? args.step : 1;
  const pointValue = args.pointValue && args.pointValue > 0 ? args.pointValue : 1;

  let balance = args.balance;
  if (balance === undefined || balance === null || !Number.isFinite(balance) || balance <= 0) {
    const detected = tvDetectBalance();
    balance = detected.balance ?? detected.equity;
  }
  if (!balance || !Number.isFinite(balance) || balance <= 0) {
    throw new Error(
      'No balance provided and none detectable on the page. Pass balance explicitly.',
    );
  }
  if (!(args.riskPercent > 0)) throw new Error('riskPercent must be > 0');
  if (!(args.entryPrice > 0)) throw new Error('entryPrice must be > 0');
  if (!(args.stopPercent > 0)) throw new Error('stopPercent must be > 0');

  const riskCash = (balance * args.riskPercent) / 100;
  const stopDistance = (args.entryPrice * args.stopPercent) / 100;
  const stopPrice = args.entryPrice - stopDistance;
  const rawQuantity = riskCash / (stopDistance * pointValue);
  const quantity = Math.floor((rawQuantity + step * 1e-10) / step) * step;
  const estimatedLoss = quantity * stopDistance * pointValue;

  return {
    balance,
    riskPercent: args.riskPercent,
    riskCash: Number(riskCash.toFixed(2)),
    entryPrice: args.entryPrice,
    stopPercent: args.stopPercent,
    stopDistance: Number(stopDistance.toFixed(6)),
    stopPrice: Number(stopPrice.toFixed(6)),
    pointValue,
    step,
    rawQuantity: Number(rawQuantity.toFixed(6)),
    quantity: Number(quantity.toFixed(8)),
    estimatedLoss: Number(estimatedLoss.toFixed(2)),
    note: 'Long-side math (stop below entry). For short positions swap entry/stop direction; stop distance and sizing are identical.',
  };
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type PageFunction = (args: Record<string, any>) => unknown | Promise<unknown>;

export const pageFunctions: Record<string, PageFunction> = {
  getScriptUrls: () => getPageScriptUrls(),
  tv_market_info: () => tvMarketInfo(),
  tv_ticket_state: () => tvTicketState(),
  tv_place_order: (args) => tvPlaceOrder(args as TvPlaceOrderArgs),
  tv_open_positions: () => tvOpenPositions(),
  tv_detect_balance: () => tvDetectBalance(),
  tv_position_size: (args) => tvPositionSize(args as TvPositionSizeArgs),
};
