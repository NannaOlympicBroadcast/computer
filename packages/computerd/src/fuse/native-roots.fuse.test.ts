// Boots the binary in a privileged container, as passthrough.fuse.test.ts
// does, with MOUNT_IGNORE set, and checks the kernel's view directly:
// `docker exec` runs in the container's mount namespace, so mountinfo and
// every path it touches are what a command sees. Skips without Docker or
// the binary, and skips the cases that need native roots on a host
// kernel without FUSE passthrough (Linux before 6.9).
//
// Prefers a binary for the host's architecture
// (COMPUTERD_BIN_TARGETS=linux-arm64 on an arm64 machine), falling back
// to linux-x64 under emulation.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const RUN_COMPUTERD_SCRIPT = join(REPO_ROOT, "packages/computer/test-harness/run-computerd.sh");

function pickBinary(): { binary: string; platform: string } | undefined {
  const candidates =
    process.arch === "arm64"
      ? [
          { name: "computerd-linux-arm64", platform: "linux/arm64" },
          { name: "computerd-linux-x64", platform: "linux/amd64" },
        ]
      : [{ name: "computerd-linux-x64", platform: "linux/amd64" }];
  for (const candidate of candidates) {
    const binary = join(REPO_ROOT, "artifacts/computerd", candidate.name);
    try {
      accessSync(binary);
      return { binary, platform: candidate.platform };
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}

const target = pickBinary();

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIfReal = target !== undefined && dockerAvailable() ? describe : describe.skip;

const IGNORE = "**/node_modules,!/vendor/node_modules,/dist,**/*.tsbuildinfo";

interface Booted {
  cid: string;
  url: string;
}

async function boot(env: Record<string, string>): Promise<Booted> {
  if (target === undefined) throw new Error("no computerd binary");
  const proc = spawn("bash", [RUN_COMPUTERD_SCRIPT], {
    env: {
      ...process.env,
      COMPUTERD_HARNESS_PORT: "0",
      COMPUTERD_BINARY: target.binary,
      COMPUTERD_HARNESS_PLATFORM: target.platform,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!proc.stdout || !proc.stderr) throw new Error("run-computerd.sh exposed no pipes");
  const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  await waitForExit(proc);
  if (proc.exitCode !== 0) throw new Error(`run-computerd.sh exited ${proc.exitCode}: ${stderr}`);
  const cid = stderr.match(/COMPUTERD_HARNESS_CID=([0-9a-f]+)/)?.[1];
  if (cid === undefined) throw new Error(`no container id in: ${stderr}`);
  return { cid, url: stdout.trim() };
}

function kill(booted: Booted | undefined): void {
  if (booted === undefined) return;
  spawnSync("docker", ["kill", booted.cid], { stdio: "ignore" });
}

/** Runs a shell script in the container, from /workspace. */
function sh(booted: Booted, script: string): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(
    "docker",
    ["exec", booted.cid, "sh", "-c", `cd /workspace && ${script}`],
    {
      encoding: "utf8",
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? -1 };
}

/** Mount points under /workspace, excluding the FUSE mount itself. */
function mounts(booted: Booted): string[] {
  const { stdout } = sh(booted, "cat /proc/self/mountinfo");
  return stdout
    .split("\n")
    .map((line) => line.split(" ")[4] ?? "")
    .filter((path) => path.startsWith("/workspace/"));
}

async function waitForMount(booted: Booted, path: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mounts(booted).includes(path)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// fetch pools connections, and the daemon's HTTP server closes an idle
// one after five seconds; a request that picks up a socket just as it
// closes fails with "other side closed". Once more on a fresh socket.
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, { ...init, keepalive: false });
  }
}

interface NativeInfo {
  enabled: boolean;
  reason: string;
  active: number;
  mounts: number;
  failures: number;
}

async function nativeInfo(booted: Booted): Promise<NativeInfo> {
  const response = await request(`${booted.url}/__computerd/info`);
  const body = (await response.json()) as { ignore: { fastPaths: { nativeRoots: NativeInfo } } };
  return body.ignore.fastPaths.nativeRoots;
}

async function stats(booted: Booted): Promise<{ localOps: number; vfsNodes: number }> {
  const response = await request(`${booted.url}/__computerd/stats`);
  const body = (await response.json()) as {
    vfs_nodes_count: number;
    localPaths: { localOps: number };
  };
  return { localOps: body.localPaths.localOps, vfsNodes: body.vfs_nodes_count };
}

describeIfReal("native roots under a real mount", () => {
  let booted: Booted | undefined;
  let available = false;

  beforeAll(async () => {
    booted = await boot({ MOUNT_IGNORE: IGNORE });
    available = (await nativeInfo(booted)).enabled;
  }, 120_000);

  afterAll(() => kill(booted));

  const ready = (ctx: { skip: () => void }): Booted => {
    if (booted === undefined) throw new Error("computerd container did not start");
    if (!available) ctx.skip();
    return booted;
  };

  test("a new root is mounted, and files written under it never reach the daemon", async (ctx) => {
    const b = ready(ctx);
    // The synced parent is a VFS node; make it before counting.
    sh(b, "mkdir -p app");
    const before = await stats(b);
    const result = sh(
      b,
      [
        "mkdir app/node_modules",
        // Straight after the mkdir, before the mount can have landed:
        // the first files go through FUSE, the rest natively, and all of
        // them have to end up in the backing directory either way.
        "for i in $(seq 1 500); do echo $i > app/node_modules/f$i; done",
      ].join(" && "),
    );
    expect(result.code).toBe(0);
    expect(await waitForMount(b, "/workspace/app/node_modules")).toBe(true);

    const listed = sh(
      b,
      "ls app/node_modules | wc -l && ls /tmp/workspace/app/node_modules | wc -l",
    );
    expect(listed.stdout).toBe("500\n500\n");
    const identity = sh(b, "stat -c '%d:%i' app/node_modules /tmp/workspace/app/node_modules");
    const [mounted, backing] = identity.stdout.trim().split("\n");
    expect(mounted).toBe(backing);

    const after = await stats(b);
    // Local-only content never enters the VFS, mounted or not.
    expect(after.vfsNodes).toBe(before.vfsNodes);
    // Without the mount every create would be a local op. With it, only
    // the ones that beat the mount are.
    expect(after.localOps - before.localOps).toBeLessThan(250);
  }, 60_000);

  test("files written after the mount bypass the daemon entirely", async (ctx) => {
    const b = ready(ctx);
    sh(b, "mkdir -p quiet/node_modules");
    expect(await waitForMount(b, "/workspace/quiet/node_modules")).toBe(true);
    const before = await stats(b);
    const result = sh(
      b,
      "for i in $(seq 1 300); do echo $i > quiet/node_modules/f$i; done && " +
        "cat quiet/node_modules/f* | wc -l && ls -la quiet/node_modules > /dev/null",
    );
    expect(result.stdout).toBe("300\n");
    expect((await stats(b)).localOps).toBe(before.localOps);
  }, 60_000);

  test("the mount outlives FUSE dentry revalidation", async (ctx) => {
    // The entry timeout is a second. A revalidation that reported the
    // dentry stale would have the kernel detach whatever sits on it.
    const b = ready(ctx);
    sh(b, "mkdir -p reval/node_modules && echo x > reval/node_modules/f");
    expect(await waitForMount(b, "/workspace/reval/node_modules")).toBe(true);
    sh(b, "sleep 2.5 && ls reval > /dev/null && stat reval/node_modules > /dev/null && sleep 1.5");
    expect(mounts(b)).toContain("/workspace/reval/node_modules");
    expect(sh(b, "cat reval/node_modules/f").stdout).toBe("x\n");
  }, 30_000);

  test("every local-only pattern's directory is mounted, not only node_modules", async (ctx) => {
    const b = ready(ctx);
    sh(b, "mkdir -p dist/assets && echo x > dist/assets/app.js");
    expect(await waitForMount(b, "/workspace/dist")).toBe(true);
    expect(sh(b, "cat dist/assets/app.js").stdout).toBe("x\n");
  }, 30_000);

  test("nothing but a topmost local-only directory is mounted", async (ctx) => {
    const b = ready(ctx);
    const result = sh(
      b,
      [
        // A nested root inside a root: inside the native tree already.
        "mkdir -p top/node_modules/pkg/node_modules",
        // Kept synced by an exclusion.
        "mkdir -p vendor/node_modules",
        // A file pattern: local-only, but never a mount.
        "echo x > tsconfig.tsbuildinfo",
        // A symlink where a root would be.
        "mkdir -p linked/real && ln -s real linked/node_modules",
        "sleep 1",
      ].join(" && "),
    );
    expect(result.code).toBe(0);
    expect(await waitForMount(b, "/workspace/top/node_modules")).toBe(true);
    const all = mounts(b);
    expect(all).not.toContain("/workspace/top/node_modules/pkg/node_modules");
    expect(all).not.toContain("/workspace/vendor/node_modules");
    expect(all).not.toContain("/workspace/tsconfig.tsbuildinfo");
    expect(all).not.toContain("/workspace/linked/node_modules");
  }, 30_000);

  test("removing or renaming a root gets EBUSY until it is detached", async (ctx) => {
    const b = ready(ctx);
    sh(b, "mkdir -p busy/node_modules/react && echo 1 > busy/node_modules/react/index.js");
    expect(await waitForMount(b, "/workspace/busy/node_modules")).toBe(true);

    const removed = sh(b, "rm -rf busy/node_modules");
    expect(removed.code).not.toBe(0);
    expect(removed.stderr).toMatch(/busy/i);
    // rm emptied it on the way to the refused rmdir.
    expect(sh(b, "ls -A busy/node_modules | wc -l").stdout).toBe("0\n");

    expect(sh(b, "mv busy/node_modules busy/nm2").code).not.toBe(0);
    // Emptying the contents is the documented workaround.
    sh(b, "echo 2 > busy/node_modules/x");
    expect(sh(b, "rm -rf busy/node_modules/*").code).toBe(0);

    const response = await request(`${b.url}/__computerd/native-roots/detach`, {
      method: "POST",
      body: JSON.stringify({ path: "busy/node_modules" }),
    });
    expect(await response.json()).toEqual({ detached: ["/workspace/busy/node_modules"] });
    expect(sh(b, "rm -rf busy/node_modules").code).toBe(0);
    expect(sh(b, "test ! -e /tmp/workspace/busy/node_modules").code).toBe(0);

    // The next one comes back mounted.
    sh(b, "mkdir busy/node_modules");
    expect(await waitForMount(b, "/workspace/busy/node_modules")).toBe(true);
  }, 30_000);

  test("renaming a synced ancestor carries exactly one mount along", async (ctx) => {
    const b = ready(ctx);
    sh(b, "mkdir -p pkgs/app/node_modules/react && echo hi > pkgs/app/node_modules/react/index.js");
    expect(await waitForMount(b, "/workspace/pkgs/app/node_modules")).toBe(true);
    expect(sh(b, "mv pkgs/app pkgs/web").code).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    const atNew = mounts(b).filter((path) => path === "/workspace/pkgs/web/node_modules");
    expect(atNew).toHaveLength(1);
    expect(mounts(b)).not.toContain("/workspace/pkgs/app/node_modules");
    expect(sh(b, "cat pkgs/web/node_modules/react/index.js").stdout).toBe("hi\n");
    const identity = sh(
      b,
      "stat -c '%d:%i' pkgs/web/node_modules /tmp/workspace/pkgs/web/node_modules",
    );
    const [mounted, backing] = identity.stdout.trim().split("\n");
    expect(mounted).toBe(backing);
  }, 30_000);

  test("info and stats report the mounts", async (ctx) => {
    const b = ready(ctx);
    const info = await nativeInfo(b);
    expect(info).toMatchObject({ enabled: true, reason: "active", failures: 0 });
    expect(info.active).toBe(mounts(b).length);
    expect(info.mounts).toBeGreaterThanOrEqual(info.active);
  });
});

describeIfReal("native roots across restarts", () => {
  const started: Booted[] = [];
  const images: string[] = [];

  afterAll(() => {
    for (const b of started) kill(b);
    for (const image of images) spawnSync("docker", ["rmi", "-f", image], { stdio: "ignore" });
  });

  // Stands in for a container snapshot: the disk comes back, the mount
  // table does not.
  async function restore(env: Record<string, string>): Promise<Booted> {
    const first = await boot({ MOUNT_IGNORE: IGNORE, ...env });
    started.push(first);
    sh(first, "mkdir -p a/node_modules/x b/c/node_modules && echo kept > a/node_modules/x/f");
    expect(await waitForMount(first, "/workspace/b/c/node_modules")).toBe(true);
    const name = `computerd-native-roots-restore:${first.cid.slice(0, 12)}`;
    images.push(name);
    execFileSync("docker", ["commit", first.cid, name], { stdio: "ignore" });
    kill(first);
    const second = await boot({
      MOUNT_IGNORE: IGNORE,
      COMPUTERD_HARNESS_IMAGE: name,
      ...env,
    });
    started.push(second);
    return second;
  }

  test("with a file store, a restored container mounts its roots at startup", async (ctx) => {
    const second = await restore({ COMPUTERD_DB: "/var/lib/computerd/state.db" });
    if (!(await nativeInfo(second)).enabled) ctx.skip();
    expect(await waitForMount(second, "/workspace/a/node_modules")).toBe(true);
    expect(await waitForMount(second, "/workspace/b/c/node_modules")).toBe(true);
    expect(mounts(second)).not.toContain("/workspace/a/node_modules/x");
    expect(sh(second, "cat a/node_modules/x/f").stdout).toBe("kept\n");
    expect((await nativeInfo(second)).failures).toBe(0);
  }, 120_000);

  test("with an in-memory store, a root mounts on first lookup once its parent is back", async (ctx) => {
    // The VFS starts empty and the host pushes synced directories back
    // later, so at startup there is nothing to mount onto yet.
    const second = await restore({});
    if (!(await nativeInfo(second)).enabled) ctx.skip();
    await new Promise((r) => setTimeout(r, 500));
    expect(mounts(second)).toEqual([]);
    expect((await nativeInfo(second)).failures).toBe(0);
    // Stands in for the host's push of the synced parent.
    sh(second, "mkdir a");
    expect(sh(second, "cat a/node_modules/x/f").stdout).toBe("kept\n");
    expect(await waitForMount(second, "/workspace/a/node_modules")).toBe(true);
  }, 120_000);

  test("SIGTERM detaches the roots before unmounting FUSE", async (ctx) => {
    const b = await boot({ MOUNT_IGNORE: IGNORE });
    started.push(b);
    if (!(await nativeInfo(b)).enabled) ctx.skip();
    sh(b, "mkdir -p node_modules && echo x > node_modules/f");
    expect(await waitForMount(b, "/workspace/node_modules")).toBe(true);
    // Followed live: the container runs with --rm, so its logs are gone
    // once it exits.
    const follower = spawn("docker", ["logs", "-f", "--since", "0s", b.cid], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = Promise.all([
      drain(follower.stdout as NodeJS.ReadableStream),
      drain(follower.stderr as NodeJS.ReadableStream),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    // computerd is PID 1, so `docker stop` delivers SIGTERM to it.
    execFileSync("docker", ["stop", "-t", "10", b.cid], { stdio: "ignore" });
    const [out, err] = await logs;
    expect(`${out}${err}`).not.toMatch(/failed to unmount FUSE/);
  }, 60_000);

  test("COMPUTERD_FUSE_NATIVE_ROOTS=0 turns them off, leaving passthrough", async () => {
    const b = await boot({ MOUNT_IGNORE: IGNORE, COMPUTERD_FUSE_NATIVE_ROOTS: "0" });
    started.push(b);
    const info = await nativeInfo(b);
    expect(info.enabled).toBe(false);
    expect(info.reason).toMatch(/COMPUTERD_FUSE_NATIVE_ROOTS/);
    sh(b, "mkdir -p node_modules && echo x > node_modules/f && sleep 1");
    expect(mounts(b)).toEqual([]);
    expect(sh(b, "cat node_modules/f").stdout).toBe("x\n");
  }, 60_000);

  test("without passthrough, native roots stay off and nothing is mounted", async () => {
    const b = await boot({ MOUNT_IGNORE: IGNORE, COMPUTERD_FUSE_PASSTHROUGH: "0" });
    started.push(b);
    const info = await nativeInfo(b);
    expect(info.enabled).toBe(false);
    expect(info.reason).toMatch(/COMPUTERD_FUSE_PASSTHROUGH/);
    sh(b, "mkdir -p node_modules && echo x > node_modules/f && sleep 1");
    expect(mounts(b)).toEqual([]);
    expect(sh(b, "cat node_modules/f").stdout).toBe("x\n");
  }, 60_000);
});

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolveStream, rejectStream) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolveStream(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", rejectStream);
  });
}

async function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
}
