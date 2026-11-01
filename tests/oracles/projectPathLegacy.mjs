// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/core/utils/projectPath.ts at c41f8ce. Test use only.
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
export function isBareHomeDirectory(dirPath) {
    try {
        return resolve(dirPath) === resolve(homedir());
    }
    catch {
        return false;
    }
}
export function isUnsafeFallbackPath(dirPath) {
    return isBareHomeDirectory(dirPath) && !isValidProjectDirectory(dirPath);
}
export function selectProjectSource(facts) {
    if (facts.hasCursorEnv)
        return 'CURSOR env';
    if (facts.hasAgentTranscripts)
        return 'AGENT_TRANSCRIPTS';
    if (facts.hasValidM7Path)
        return facts.rootsComplete ? 'M7_PROJECT_PATH' : 'process.cwd()';
    if (facts.cwdAllowsScan)
        return 'Cursor projects dir';
    return 'process.cwd()';
}
export function needsProjectSwitch(current, next) {
    return current === null || resolve(current) !== resolve(next);
}
export function isValidProjectDirectory(projectPath) {
    if (!existsSync(projectPath)) {
        return false;
    }
    const indicators = [
        'package.json',
        '.git',
        'tsconfig.json',
        'pyproject.toml',
        'Cargo.toml',
        'go.mod',
        'pom.xml'
    ];
    return indicators.some(indicator => existsSync(join(projectPath, indicator)));
}
