---
"@cloudflare/computerd": minor
---

Bind-mount local-only directories named in `MOUNT_NATIVE`

`MOUNT_NATIVE` names a subset of the `MOUNT_IGNORE` patterns whose
directories computerd bind-mounts onto the mount from the place it already
stores them, under `MOUNT_IGNORE_PATH`. Everything under such a directory is
then served by the kernel from the container's disk: lookups, `stat`,
creates, and listings no longer reach computerd, where FUSE passthrough alone
only took the file data off its path. Content is the same either way, so a
mount that fails or lands late changes speed, not what a command sees.

A directory is mounted when a command creates it, when a lookup finds one on
disk that is not mounted yet (after a snapshot restore), and at startup.
Native roots need negotiated FUSE passthrough, `CAP_SYS_ADMIN`, and `mount`
from util-linux; without them nothing changes. `/__computerd/info` reports
the state under `ignore.fastPaths.nativeRoots`.

Removing or renaming a mounted directory itself fails with `EBUSY`, as for a
Docker volume. `POST /__computerd/native-roots/detach` detaches one, or all,
first. Unset `MOUNT_NATIVE` leaves behavior exactly as it was.
