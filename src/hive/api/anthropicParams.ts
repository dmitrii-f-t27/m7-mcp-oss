// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Sampling parameters for Anthropic Messages API calls.
 *
 * Newer Opus models are said to reject a non-default `temperature`. That has
 * not been verified against the live API: no test in this repository makes a
 * network call. M7 therefore sends no `temperature` to any model whose name
 * starts with `claude-opus-`, and keeps it for every other model. Opus calls run
 * at the API default temperature.
 *
 * Both functions are pure and small on purpose. The decision is written in t27
 * (specs/policy_rules.t27) and runs as WebAssembly; a model name over 256 bytes,
 * or a failing backend, takes no temperature.
 */

import { modelTakesTemp } from '../../rules/policyRules.js';

/** True when M7 may send a `temperature` to this model. */
export function modelTakesTemperature(model: string): boolean {
  return modelTakesTemp(model);
}

/**
 * The sampling part of a `messages.create` request: `{ temperature }` for a
 * model that takes one, `{}` for an Opus model. Spread it into the request:
 * `{ model, max_tokens, ...anthropicSampling(model, 0.1), system, messages }`.
 */
export function anthropicSampling(model: string, temperature: number): { temperature?: number } {
  return modelTakesTemperature(model) ? { temperature } : {};
}
