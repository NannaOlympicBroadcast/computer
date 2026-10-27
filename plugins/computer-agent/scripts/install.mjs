#!/usr/bin/env node
// Multi-host plugin & CLI installer for `computer-agent`:
//   1. Google Antigravity   -> ~/.gemini/config/plugins/computer-agent
//   2. Anthropic Claude Code -> ~/.claude/plugins/computer-agent & ~/.claude/skills/computer-agent
//   3. OpenAI Codex CLI     -> ~/.codex/plugins/computer-agent, ~/.agents/skills/computer-agent, and <repo>/.agents/skills/computer-agent
//   4. Standalone CLI shims -> ~/.local/bin/computer-cli & ~/.local/bin/computer-cli.cmd

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const home = os.homedir();

async function copyPluginTo(destDir) {
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.cp(pluginRoot, destDir, { recursive: true });

  // Write repo-root.json so the installed copy resolves @cloudflare/computer & @modelcontextprotocol/sdk from repoRoot
  await fs.writeFile(
    path.join(destDir, "repo-root.json"),
    `${JSON.stringify({ repoRoot }, null, 2)}\n`,
    "utf8",
  );

  const absServerPath = path.join(destDir, "mcp", "server.mjs");

  // Write absolute server path into mcp_config.json & mcp.json so any host cwd works reliably
  const mcpConfig = {
    mcpServers: {
      "computer-agent": {
        command: "node",
        args: [absServerPath],
        env: {
          COMPUTER_REPO_ROOT: repoRoot,
        },
      },
    },
  };
  await fs.writeFile(
    path.join(destDir, "mcp_config.json"),
    `${JSON.stringify(mcpConfig, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(destDir, "mcp.json"),
    `${JSON.stringify(mcpConfig, null, 2)}\n`,
    "utf8",
  );
}

async function copySkillTo(destSkillDir) {
  await fs.rm(destSkillDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destSkillDir), { recursive: true });
  await fs.cp(path.join(pluginRoot, "skills", "computer-agent"), destSkillDir, {
    recursive: true,
  });
}

async function installCliShims() {
  const binDir = path.join(home, ".local", "bin");
  await fs.mkdir(binDir, { recursive: true });
  const cliEntry = path.join(pluginRoot, "bin", "computer-cli.mjs");

  const shScript = `#!/usr/bin/env sh
export COMPUTER_REPO_ROOT="${repoRoot.replace(/\\/g, "/")}"
exec node "${cliEntry.replace(/\\/g, "/")}" "$@"
`;
  const cmdScript = `@echo off
set "COMPUTER_REPO_ROOT=${repoRoot}"
node "${cliEntry}" %*
`;

  const shPath = path.join(binDir, "computer-cli");
  const cmdPath = path.join(binDir, "computer-cli.cmd");
  await fs.writeFile(shPath, shScript, { encoding: "utf8", mode: 0o755 });
  await fs.writeFile(cmdPath, cmdScript, { encoding: "utf8" });
  return { shPath, cmdPath };
}

async function main() {
  const antigravityDir = path.join(home, ".gemini", "config", "plugins", "computer-agent");
  const claudePluginDir = path.join(home, ".claude", "plugins", "computer-agent");
  const claudeSkillDir = path.join(home, ".claude", "skills", "computer-agent");
  const codexPluginDir = path.join(home, ".codex", "plugins", "computer-agent");
  const globalAgentSkillDir = path.join(home, ".agents", "skills", "computer-agent");
  const repoAgentSkillDir = path.join(repoRoot, ".agents", "skills", "computer-agent");

  await copyPluginTo(antigravityDir);
  await copyPluginTo(claudePluginDir);
  await copyPluginTo(codexPluginDir);

  await copySkillTo(claudeSkillDir);
  await copySkillTo(globalAgentSkillDir);
  await copySkillTo(repoAgentSkillDir);

  const shims = await installCliShims();

  console.log(
    JSON.stringify(
      {
        ok: true,
        repoRoot,
        installed: {
          antigravityPlugin: antigravityDir,
          claudeCodePlugin: claudePluginDir,
          claudeCodeSkill: claudeSkillDir,
          codexPlugin: codexPluginDir,
          globalAgentSkill: globalAgentSkillDir,
          repoAgentSkill: repoAgentSkillDir,
          cliShims: shims,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
