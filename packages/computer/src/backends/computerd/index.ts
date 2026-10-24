// Public surface of @cloudflare/computer/backends/computerd.
//
// Backends that run a Workspace without Cloudflare: ComputerdBackend
// dials a running `computerd`; DockerContainerBackend starts one in
// Docker. See computerd-backend.ts and docker.ts.

export {
  ComputerdBackend,
  type ComputerdBackendOptions,
  waitForComputerd,
} from "./computerd-backend.js";
export {
  DockerContainerBackend,
  type DockerContainerBackendOptions,
  type DockerDesktopOptions,
} from "./docker.js";
