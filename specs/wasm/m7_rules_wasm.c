// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
// The one translation unit of wasm/m7_rules.wasm. specs/generate.sh builds it with zig cc.
//
// 1. Every generated spec header, in the order of specs/ORDER. One translation unit means a function or
//    test name used in two specs is a compile error here. generate.sh refuses a header that is missing.
// 2. Scratch buffers and their accessors. A buffer declared in a spec is dropped by --gc-sections, so
//    the buffers live here and the host reads their address with an accessor that exports.txt names.
//    The host writes text into a buffer, calls a rule with the buffer's address and the true length, and
//    reads the answer. It reads memory.buffer again after every call.
#include "bytes_rules.h"
#include "path_tables.h"
#include "path_rules.h"
#include "net_rules.h"
#include "policy_rules.h"

// path_rules: two path buffers (root and target, current and next, one name), the folded segment being
// built and the joined folded text that a verdict reads.
static uint8_t pr_buf_a[PR_PATH_MAX];
static uint8_t pr_buf_b[PR_PATH_MAX];
static uint8_t pr_buf_seg[PR_FOLDED_MAX];
static uint8_t pr_buf_joined[PR_FOLDED_MAX];

uint8_t *pr_addr_a(void) { return pr_buf_a; }
uint8_t *pr_addr_b(void) { return pr_buf_b; }
uint8_t *pr_addr_seg(void) { return pr_buf_seg; }
uint8_t *pr_addr_joined(void) { return pr_buf_joined; }

// net_rules: the Host or Origin text.
static uint8_t nr_buf_text[NR_TEXT_MAX];
uint8_t *nr_addr_text(void) { return nr_buf_text; }

// policy_rules: the start of a file, the NUL-ended names of a directory listing, a model name or an environment value.
static uint8_t po_buf_head[PO_HEAD_MAX];
static uint8_t po_buf_list[PO_LIST_MAX];
static uint8_t po_buf_text[PO_TEXT_MAX];
uint8_t *po_addr_head(void) { return po_buf_head; }
uint8_t *po_addr_list(void) { return po_buf_list; }
uint8_t *po_addr_text(void) { return po_buf_text; }
