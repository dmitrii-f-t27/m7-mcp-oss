// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/visualizer/visualizer-server.ts at c41f8ce. Test use only.
export const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];
export function isHostAllowed(hostHeader, httpPort) {
    if (typeof hostHeader !== 'string')
        return false;
    const host = hostHeader.toLowerCase();
    return LOOPBACK_NAMES.some((name) => host === `${name}:${httpPort}`);
}
export function isOriginAllowed(origin, httpPort) {
    if (origin === undefined)
        return true;
    const value = origin.toLowerCase();
    return LOOPBACK_NAMES.some((name) => value === `http://${name}:${httpPort}`);
}
