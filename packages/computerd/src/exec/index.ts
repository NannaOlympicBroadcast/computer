export {
  type CommandResult,
  type DesktopCommandRunner,
  DesktopController,
  type DesktopControllerOptions,
  type DesktopProcessSpawner,
  type ManagedProcess,
  normalizeKeySpec,
  parseDesktopEnv,
  parseImageDimensions,
  parseResolution,
} from "../desktop/index.js";
export { createLog, EventLog, openLog } from "./log.js";
export { type ExecHandle, Runner, type RunnerInit } from "./runner.js";
export { clearExecState, initializeExecSchema } from "./schema.js";
export {
  ExecError,
  type ExecErrorCode,
  type ExecEvent,
  type ExecOptions,
  type RunnerOptions,
} from "./types.js";
