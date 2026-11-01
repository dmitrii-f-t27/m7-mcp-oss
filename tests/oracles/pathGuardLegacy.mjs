// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// Oracle: src/core/security/pathGuard.ts at c41f8ce. Test use only.
const SLASH = 47;
const BACKSLASH = 92;
const UPPER_A = 65;
const UPPER_Z = 90;
const CASE_GAP = 32;
export const REFUSE_NUL = 'the path contains a NUL byte';
export const REFUSE_SECRET = 'a secret or credential file is never exchanged';
export const REFUSE_CONTROL = 'a git, editor or M7 control path is never written from a peer';
export const SECRET_NAMES = [
    '.env', '.envrc', '.npmrc', '.netrc', '.pypirc', '.pgpass', '.git-credentials',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    'credentials', '.aws', '.ssh', '.docker', '.kube', '.gnupg',
];
export const SECRET_PREFIXES = ['.env.'];
export const SECRET_SUFFIXES = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.env'];
export const CONTROL_NAMES = [
    '.git', '.cursor', '.cursorrules', '.vscode', '.claude', '.m7', '.husky', '.github', '.mcp.json',
    'claude.md', 'agents.md', 'gemini.md', '.clinerules', '.windsurfrules', '.devcontainer', '.idea',
    '.gitmodules', '.gitattributes',
];
export function isSeparator(code, win) {
    return code === SLASH || (win && code === BACKSLASH);
}
export function foldAscii(code) {
    return code >= UPPER_A && code <= UPPER_Z ? code + CASE_GAP : code;
}
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
export function foldUnicode(text) {
    return text.replace(IGNORABLE, '').normalize('NFKC').toUpperCase().toLowerCase().replace(IGNORABLE, '');
}
const DOT = 46;
const SPACE = 32;
export function trimTrailingDotSpace(text) {
    let end = text.length;
    while (end > 0) {
        const code = text.charCodeAt(end - 1);
        if (code !== DOT && code !== SPACE)
            break;
        end--;
    }
    return text.slice(0, end);
}
export function foldName(segment) {
    return trimTrailingDotSpace(foldUnicode(segment));
}
export function pathSegments(rel) {
    const segments = [];
    let start = 0;
    for (let i = 0; i <= rel.length; i++) {
        if (i === rel.length || isSeparator(rel.charCodeAt(i), true)) {
            if (i > start)
                segments.push(rel.slice(start, i));
            start = i + 1;
        }
    }
    return segments;
}
export function isSecretSegment(folded) {
    if (SECRET_NAMES.includes(folded))
        return true;
    for (const prefix of SECRET_PREFIXES)
        if (folded.startsWith(prefix))
            return true;
    for (const suffix of SECRET_SUFFIXES)
        if (folded.endsWith(suffix))
            return true;
    return false;
}
export function isControlSegment(folded) {
    return CONTROL_NAMES.includes(folded);
}
export function pushRefusal(rel) {
    if (rel.indexOf('\0') !== -1)
        return REFUSE_NUL;
    for (const segment of pathSegments(rel)) {
        if (isSecretSegment(foldName(segment)))
            return REFUSE_SECRET;
    }
    return null;
}
export function pullRefusal(rel) {
    const secret = pushRefusal(rel);
    if (secret !== null)
        return secret;
    for (const segment of pathSegments(rel)) {
        if (isControlSegment(foldName(segment)))
            return REFUSE_CONTROL;
    }
    return null;
}
export function isInsideWith(root, target, win) {
    const n = root.length;
    if (n === 0 || target.length < n)
        return false;
    for (let i = 0; i < n; i++) {
        const a = root.charCodeAt(i);
        const b = target.charCodeAt(i);
        if (a === b)
            continue;
        if (win && isSeparator(a, true) && isSeparator(b, true))
            continue;
        if (win && foldAscii(a) === foldAscii(b))
            continue;
        return false;
    }
    if (target.length === n)
        return true;
    if (isSeparator(root.charCodeAt(n - 1), win))
        return true;
    return isSeparator(target.charCodeAt(n), win);
}
export function isInside(root, target) {
    return isInsideWith(root, target, process.platform === 'win32');
}
export function relativeWithin(root, target) {
    if (!isInside(root, target))
        return null;
    let i = root.length;
    while (i < target.length && isSeparator(target.charCodeAt(i), process.platform === 'win32'))
        i++;
    return target.slice(i);
}
export function linkLeavesRoot(realRoot, real) {
    return real === null || !isInside(realRoot, real);
}
export function isPlainEntryName(name) {
    return name !== '' && name !== '.' && name !== '..' && name.indexOf('\0') === -1;
}
