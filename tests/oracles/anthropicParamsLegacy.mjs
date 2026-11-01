// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/hive/api/anthropicParams.ts at c41f8ce. Test use only.
export function modelTakesTemperature(model) {
    return !model.startsWith('claude-opus-');
}
