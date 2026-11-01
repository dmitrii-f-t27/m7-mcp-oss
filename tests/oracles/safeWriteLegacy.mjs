// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/core/utils/safeWrite.ts at c41f8ce. Test use only.
export const M7_MANAGED_MARKER = '<!-- m7-managed -->';
export const MANAGED_SCAN_BYTES = 4096;
export function hasManagedMarker(content) {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    return bytes.subarray(0, MANAGED_SCAN_BYTES).includes(M7_MANAGED_MARKER);
}
export function managedStateOf(head) {
    if (head === null)
        return 'absent';
    return hasManagedMarker(head) ? 'managed' : 'foreign';
}
export function managedWriteAction(state) {
    if (state === 'absent')
        return 'create';
    if (state === 'managed')
        return 'update';
    return 'skip';
}
export function managedSyncAction(state) {
    return state === 'managed' ? 'sync' : 'skip';
}
