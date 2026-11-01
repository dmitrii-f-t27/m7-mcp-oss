// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/core/intelligence/intentClassifier.ts at c41f8ce. Test use only.
export function isRemoteClassificationEnabled(env = process.env) {
    return env.M7_ALLOW_REMOTE_CLASSIFICATION === 'true';
}
