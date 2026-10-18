// Bulk replay attack engine (TS port of rep+ bulk-replay/engine.js).
// Burp Intruder-style modes over a request template with § position markers.

export type AttackType = 'sniper' | 'battering-ram' | 'pitchfork' | 'cluster-bomb';

export interface PositionConfig {
  type: 'simple-list' | 'numbers';
  list?: string;
  numbers?: { from: number; to: number; step: number };
}

export interface GeneratedAttackRequest {
  payloads: string[];
  requestContent: string;
}

export function generatePayloadsForPosition(config: PositionConfig): string[] {
  if (config.type === 'simple-list' && typeof config.list === 'string') {
    return config.list.split('\n').filter((line) => line.trim() !== '');
  }
  if (config.type === 'numbers' && config.numbers) {
    const { from, to, step } = config.numbers;
    const payloads: string[] = [];
    if (step <= 0) throw new Error('numbers.step must be > 0');
    for (let i = from; i <= to; i += step) payloads.push(i.toString());
    return payloads;
  }
  return [];
}

function replacePositions(template: string, payloads: string[]): string {
  let index = 0;
  return template.replace(/§[\s\S]*?§/g, () => payloads[index++] ?? '');
}

function generateSniperRequests(
  positionConfigs: PositionConfig[],
  template: string,
): GeneratedAttackRequest[] {
  const requests: GeneratedAttackRequest[] = [];
  positionConfigs.forEach((config, posIndex) => {
    for (const payload of generatePayloadsForPosition(config)) {
      const payloadArray = positionConfigs.map((c, i) =>
        i === posIndex ? payload : sampleOriginal(c),
      );
      requests.push({
        payloads: payloadArray,
        requestContent: replacePositions(template, payloadArray),
      });
    }
  });
  return requests;
}

function sampleOriginal(config: PositionConfig): string {
  const payloads = generatePayloadsForPosition(config);
  return payloads[0] ?? '';
}

function generateBatteringRamRequests(
  positionConfigs: PositionConfig[],
  template: string,
): GeneratedAttackRequest[] {
  const requests: GeneratedAttackRequest[] = [];
  const payloads = generatePayloadsForPosition(positionConfigs[0]);
  for (const payload of payloads) {
    const payloadArray = positionConfigs.map(() => payload);
    requests.push({
      payloads: payloadArray,
      requestContent: replacePositions(template, payloadArray),
    });
  }
  return requests;
}

function generatePitchforkRequests(
  positionConfigs: PositionConfig[],
  template: string,
): GeneratedAttackRequest[] {
  const requests: GeneratedAttackRequest[] = [];
  const allPayloads = positionConfigs.map(generatePayloadsForPosition);
  const minLength = Math.min(...allPayloads.map((p) => p.length));
  for (let i = 0; i < minLength; i++) {
    const payloadArray = allPayloads.map((payloads) => payloads[i]);
    requests.push({
      payloads: payloadArray,
      requestContent: replacePositions(template, payloadArray),
    });
  }
  return requests;
}

function generateClusterBombRequests(
  positionConfigs: PositionConfig[],
  template: string,
): GeneratedAttackRequest[] {
  const allPayloads = positionConfigs.map(generatePayloadsForPosition);
  const cartesian = (...arrays: string[][]): string[][] =>
    arrays.reduce<string[][]>(
      (acc, array) => acc.flatMap((x) => array.map((y) => [...x, y])),
      [[]],
    );
  const combinations = cartesian(...allPayloads);
  return combinations.map((payloadArray) => ({
    payloads: payloadArray,
    requestContent: replacePositions(template, payloadArray),
  }));
}

export function generateAttackRequests(
  attackType: AttackType,
  positionConfigs: PositionConfig[],
  template: string,
): GeneratedAttackRequest[] {
  const positionCount = (template.match(/§[\s\S]*?§/g) || []).length;
  if (positionCount !== positionConfigs.length) {
    throw new Error(
      `Template has ${positionCount} § position marker(s) but ${positionConfigs.length} position config(s) were provided`,
    );
  }
  if (positionConfigs.length === 0) {
    throw new Error('No § position markers found in the request template');
  }
  switch (attackType) {
    case 'sniper':
      return generateSniperRequests(positionConfigs, template);
    case 'battering-ram':
      return generateBatteringRamRequests(positionConfigs, template);
    case 'pitchfork':
      return generatePitchforkRequests(positionConfigs, template);
    case 'cluster-bomb':
      return generateClusterBombRequests(positionConfigs, template);
    default:
      throw new Error(`Unknown attack type: ${attackType as string}`);
  }
}
