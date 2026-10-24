// Public surface of @cloudflare/computer/backends/computerd.
//
// Backends that run a Workspace without Cloudflare: ComputerdBackend
// dials a running `computerd`; DockerContainerBackend starts one in
// Docker; TailscaleComputerdBackend resolves and connects to a
// `computerd` peer across a Tailscale Tailnet.

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
export {
  discoverTailscalePeers,
  resolveTailscaleTarget,
  TailscaleComputerdBackend,
  type TailscaleComputerdBackendOptions,
  type TailscaleDiscoverOptions,
  type TailscalePeerInfo,
} from "./tailscale.js";
