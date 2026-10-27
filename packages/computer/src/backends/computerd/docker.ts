// DockerContainerBackend: run `computerd` in a local Docker container.
//
// connect() runs `docker run -d` with a published port, waits for the
// daemon, and hands the connection to ComputerdBackend. close()
// removes the container it started. The image is yours to build; see
// packages/computerd/Dockerfile.desktop for a desktop image.
//
// The `docker` CLI is reached through `process.getBuiltinModule`, so
// importing this module never pulls node:child_process into workerd.

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { ComputerdBackend, waitForComputerd } from "./computerd-backend.js";

export interface DockerDesktopOptions {
  // Screen size, `WIDTHxHEIGHT[xDEPTH]`. Default 1280x800x24.
  resolution?: string;
  // X display inside the container. Default ":99".
  display?: string;
  // Host port to publish VNC (container port 5900) on. Omit to skip.
  hostVncPort?: number;
  // Host port to publish noVNC (container port 6080) on. Omit to skip.
  hostNoVncPort?: number;
}

export interface DockerContainerBackendOptions {
  // Stable id used to address this backend. Defaults to "docker".
  id?: string;
  // Image to run. Defaults to "computerd-desktop:latest" when
  // `desktop` is set, otherwise "computerd:latest".
  image?: string;
  // Enable the desktop. `true` uses defaults.
  desktop?: boolean | DockerDesktopOptions;
  // Docker container name. Defaults to a random name.
  name?: string;
  // Host port to publish computerd on. Default: a free port Docker picks.
  hostPort?: number;
  // Port computerd listens on inside the container. Default 8080.
  containerPort?: number;
  // Host the published port is reachable on. Default 127.0.0.1.
  host?: string;
  // Bearer secret. Default: a random one generated per backend.
  secret?: string;
  // Path computerd mounts the workspace at inside the container.
  mountPoint?: string;
  // MOUNT_IGNORE patterns, as ContainerBackend's `ignore`.
  ignore?: readonly string[];
  // Extra environment variables for the container.
  env?: Record<string, string>;
  // Extra `docker run` arguments, such as `--privileged` or `--device`.
  dockerArgs?: readonly string[];
  // Docker binary. Default "docker".
  dockerBin?: string;
  // Milliseconds to wait for the daemon. Default 60s.
  readyTimeoutMs?: number;
  description?: string;
}

interface ExecFileResult {
  stdout: string;
  stderr: string;
}
type ExecFile = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

function execFile(file: string, args: readonly string[]): Promise<ExecFileResult> {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const cp = proc?.getBuiltinModule?.("node:child_process") as { execFile?: ExecFile } | undefined;
  const run = cp?.execFile;
  if (!run) {
    throw new Error("DockerContainerBackend needs Node.js; node:child_process is unavailable.");
  }
  return new Promise((resolve, reject) => {
    run(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export class DockerContainerBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type = "docker";
  readonly description?: string;
  readonly #options: DockerContainerBackendOptions;
  readonly #secret: string;

  constructor(options: DockerContainerBackendOptions = {}) {
    this.id = options.id ?? "docker";
    this.#options = options;
    this.#secret = options.secret ?? crypto.randomUUID();
    if (options.description !== undefined) this.description = options.description;
  }

  async connect(): Promise<BackendHandle> {
    const options = this.#options;
    const docker = options.dockerBin ?? "docker";
    const desktop =
      options.desktop === undefined || options.desktop === false
        ? undefined
        : options.desktop === true
          ? {}
          : options.desktop;
    const image = options.image ?? (desktop ? "computerd-desktop:latest" : "computerd:latest");
    const containerPort = options.containerPort ?? 8080;
    const name = options.name ?? `computerd-${randomId()}`;
    const env: Record<string, string> = {
      PORT: String(containerPort),
      RPC_CLIENT_SECRET: this.#secret,
      ...(options.mountPoint ? { MOUNT_POINT: options.mountPoint } : {}),
      ...(options.ignore ? { MOUNT_IGNORE: options.ignore.join(",") } : {}),
      ...(desktop
        ? {
            DESKTOP_ENABLED: "1",
            ...(desktop.resolution ? { DESKTOP_RESOLUTION: desktop.resolution } : {}),
            ...(desktop.display ? { DESKTOP_DISPLAY: desktop.display } : {}),
          }
        : {}),
      ...options.env,
    };
    const args = ["run", "-d", "--name", name];
    args.push("-p", `${options.hostPort ?? ""}:${containerPort}`.replace(/^:/, ""));
    if (desktop?.hostVncPort !== undefined) args.push("-p", `${desktop.hostVncPort}:5900`);
    if (desktop?.hostNoVncPort !== undefined) args.push("-p", `${desktop.hostNoVncPort}:6080`);
    for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
    args.push(...(options.dockerArgs ?? []), image);

    await execFile(docker, args);
    const remove = async (): Promise<void> => {
      await execFile(docker, ["rm", "-f", name]).catch(() => undefined);
    };
    try {
      const { stdout } = await execFile(docker, ["port", name, `${containerPort}/tcp`]);
      const mapping = stdout.split(/\r?\n/).find((line) => /:\d+$/.test(line.trim()));
      const hostPort = mapping?.trim().match(/:(\d+)$/)?.[1];
      if (hostPort === undefined) {
        throw new Error(`docker did not publish port ${containerPort} for ${name}`);
      }
      const url = `http://${options.host ?? "127.0.0.1"}:${hostPort}`;
      await waitForComputerd(url, this.#secret, options.readyTimeoutMs ?? 60_000);
      const inner = new ComputerdBackend({
        id: this.id,
        url,
        secret: this.#secret,
        probeHealth: false,
      });
      const handle = await inner.connect();
      return {
        ...handle,
        close: async () => {
          try {
            await handle.close();
          } finally {
            await remove();
          }
        },
      };
    } catch (error) {
      await remove();
      throw error;
    }
  }
}
