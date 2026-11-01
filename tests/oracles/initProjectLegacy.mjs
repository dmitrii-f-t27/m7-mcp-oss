// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/core/tools/initProject.ts at c41f8ce. Test use only.
export const NOT_PROJECT_FILES = ['.git', '.gitignore', '.DS_Store', '.m7'];
export function isEmptyListing(names) {
    return names.every(name => NOT_PROJECT_FILES.includes(name));
}
export function needsInitNoteFor(state) {
    return !state.isEmpty && !state.hasMemoryBank && !state.hasCursorRules;
}
