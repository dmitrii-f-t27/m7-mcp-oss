// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// The one translation unit of wasm/m7_rules.wasm. specs/generate.sh builds it with zig cc.
//
// 1. Every generated spec header, in the order of specs/ORDER. One translation unit means a function or
//    test name used in two specs is a compile error here. generate.sh refuses a header that is missing.
// 2. Scratch buffers and their accessors. A buffer declared in a spec is dropped by --gc-sections, so
//    the buffers live here and the host reads their address with an accessor that exports.txt names.
//    bytes_rules takes and returns single bytes, so it needs none.
#include "bytes_rules.h"
