---
"@cloudflare/computerd": minor
---

Bind-mount local-only directories

With `MOUNT_IGNORE` set, computerd now bind-mounts each local-only directory
onto the mount from the place it already stores it, under `MOUNT_IGNORE_PATH`.
Everything under such a directory is then served by the kernel from the
container's disk: lookups, `stat`, creates, and listings no longer reach
computerd, where FUSE passthrough alone only took the file data off its path.
Content is the same either way, so a mount that fails or lands late changes
speed, not what a command sees.

A directory is mounted when a command creates it, when a lookup finds one on
disk that is not mounted yet (after a snapshot restore), and at startup.
Native roots need negotiated FUSE passthrough, `CAP_SYS_ADMIN`, and `mount`
from util-linux; without them local-only paths are served as before.
`COMPUTERD_FUSE_NATIVE_ROOTS=0` turns them off. `/__computerd/info` reports
the state under `ignore.fastPaths.nativeRoots`.

Removing or renaming a mounted directory itself fails with `EBUSY`, as for a
Docker volume. `POST /__computerd/native-roots/detach` detaches one, or all,
first.
