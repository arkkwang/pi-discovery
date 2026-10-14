export function thinkingLevel(value = 'medium', key = 'thinkingLevel') {
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new Error(`${key} must be off, minimal, low, medium, high, xhigh or max`);
  }
  return value;
}

// Split only the first slash: a model ID may itself contain provider namespaces.
export function parseModel(value, key = 'model') {
  if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value)) {
    throw new Error(`${key} must be a provider/model string with nonempty parts and no whitespace`);
  }
  const slash = value.indexOf('/');
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function checkedOptions(value, defaults, key) {
  const keys = Object.keys(defaults);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new Error(`${key} accepts only ${keys.join(', ')}`);
  }
  return { ...defaults, ...value };
}

// Boundary budget shared by preparation and review; enforced per option group.
function boundaryBudget(value, key) {
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error(`${key} must be an integer 1000–600000`);
  }
  return value;
}

export function recommendationOptions(value = {}) {
  const key = 'capabilityDiscovery.recommendation';
  const result = checkedOptions(value, {
    model: 'llama/iq3', capabilityPrediction: false, actionPrediction: false,
    maxSuggestedActions: 3, thinkingLevel: 'medium', toolSearchThinkingLevel: 'medium', timeoutMs: 60_000,
  }, key);
  parseModel(result.model, `${key}.model`);
  for (const field of ['capabilityPrediction', 'actionPrediction']) {
    if (typeof result[field] !== 'boolean') throw new Error(`${key}.${field} must be boolean`);
  }
  if (!Number.isInteger(result.maxSuggestedActions) || result.maxSuggestedActions < 0 || result.maxSuggestedActions > 8) {
    throw new Error(`${key}.maxSuggestedActions must be an integer 0–8`);
  }
  result.thinkingLevel = thinkingLevel(result.thinkingLevel, `${key}.thinkingLevel`);
  result.toolSearchThinkingLevel = thinkingLevel(result.toolSearchThinkingLevel, `${key}.toolSearchThinkingLevel`);
  result.timeoutMs = boundaryBudget(result.timeoutMs, `${key}.timeoutMs`);
  return result;
}

export function trajectoryOptions(value = {}) {
  const key = 'capabilityDiscovery.trajectory';
  const result = checkedOptions(value, { model: 'llama/iq3', enabled: false, everySteps: 5, thinkingLevel: 'medium', timeoutMs: 60_000 }, key);
  parseModel(result.model, `${key}.model`);
  if (typeof result.enabled !== 'boolean') throw new Error(`${key}.enabled must be boolean`);
  if (!Number.isInteger(result.everySteps) || result.everySteps < 0 || result.everySteps > 1000) {
    throw new Error(`${key}.everySteps must be an integer 0–1000`);
  }
  result.thinkingLevel = thinkingLevel(result.thinkingLevel, `${key}.thinkingLevel`);
  result.timeoutMs = boundaryBudget(result.timeoutMs, `${key}.timeoutMs`);
  return result;
}

export function discoveryOptions(value = {}) {
  const groups = checkedOptions(value, { recommendation: {}, trajectory: {} }, 'capabilityDiscovery');
  return { recommendation: recommendationOptions(groups.recommendation), trajectory: trajectoryOptions(groups.trajectory) };
}
