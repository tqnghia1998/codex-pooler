const CHECK_NAMES = Object.freeze([
  'storage',
  'apiKey',
  'tokenRecovery',
  'quotaRefresh',
  'modelCatalog'
]);
const CHECK_STATES = new Set(['pending', 'ready', 'degraded', 'failed']);

export class Readiness {
  constructor(checks = {}) {
    this.checks = Object.fromEntries(CHECK_NAMES.map((name) => [
      name,
      CHECK_STATES.has(checks[name]) ? checks[name] : 'pending'
    ]));
  }

  set(name, state) {
    if (!CHECK_NAMES.includes(name)) throw new Error(`Unknown readiness check ${name}`);
    if (!CHECK_STATES.has(state)) throw new Error(`Invalid readiness state ${state}`);
    this.checks[name] = state;
    return this.status();
  }

  status() {
    const checks = { ...this.checks };
    const states = Object.values(checks);
    return {
      status: states.includes('failed') ? 'failed' : states.includes('pending') ? 'pending' : 'ready',
      checks
    };
  }
}

export function readyReadiness() {
  return new Readiness(Object.fromEntries(CHECK_NAMES.map((name) => [name, 'ready'])));
}
