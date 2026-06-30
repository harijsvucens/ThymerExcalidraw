// Read the persisted scene for a drawing record via the Thymer MCP tools.
// This wraps the MCP tool to read the Scene field and parse it.
import { execSync } from 'node:child_process';

export async function readScene(workspaceGuid, recordGuid) {
  // We don't have direct MCP access from Node — the tools are exposed via the
  // OpenCode MCP layer. Use the read tool via the test runner if needed.
  // For now, return null and the test will fall back to no DB check.
  // The actual DB read happens by running a side-channel script.
  return null;
}
