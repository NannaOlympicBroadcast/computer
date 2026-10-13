---
"@cloudflare/dofs": patch
---

Resolve each path segment with a full `(parent_inode, name)` key seek, so lookups no longer scan every child of a wide directory.
