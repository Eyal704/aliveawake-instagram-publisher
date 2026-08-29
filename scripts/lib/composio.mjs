import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

function assertResult(result, tool) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${tool} returned JSON with an unexpected top-level shape.`);
  }
  if (result.successful === false || result.error) {
    throw new Error(`${tool} failed: ${JSON.stringify(result.error || result)}`);
  }
  if (!("data" in result)) {
    throw new Error(`${tool} returned no data key after Composio output resolution.`);
  }
  return result;
}

/**
 * Resolve the Composio CLI's large-output envelope. Large responses are written
 * to outputFilePath and the stdout JSON has no data key, so callers must never
 * inspect result.data before passing through this function.
 */
export async function resolveComposioResult(result, tool = "Composio tool") {
  if (result?.storedInFile || result?.outputFilePath) {
    if (!result.outputFilePath) {
      throw new Error(`${tool} reported storedInFile without an outputFilePath.`);
    }
    let fileRaw;
    try {
      fileRaw = await fs.readFile(result.outputFilePath, "utf8");
    } catch (error) {
      throw new Error(`${tool} offloaded its output to ${result.outputFilePath}, but it could not be read: ${error.message}`);
    }
    try {
      result = JSON.parse(fileRaw);
    } catch (error) {
      throw new Error(`${tool} offloaded invalid JSON to ${result.outputFilePath}: ${error.message}`);
    }
  }
  return assertResult(result, tool);
}

function parseJson(raw, tool) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${tool} returned invalid JSON: ${error.message}`);
  }
}

export async function executeComposioCli(tool, account, payload, options = {}) {
  const binary = options.binary || process.env.COMPOSIO || `${process.env.HOME}/.composio/composio`;
  const proc = spawnSync(binary, ["execute", tool, "--account", account, "-d", JSON.stringify(payload)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const raw = proc.stdout.trim();
  if (proc.status !== 0 || !raw) {
    throw new Error(`${tool} returned no usable JSON (exit ${proc.status}): ${proc.stderr.trim() || "empty output"}`);
  }
  return resolveComposioResult(parseJson(raw, tool), tool);
}

export async function executeComposioTool(tool, account, connectedAccountId, payload, options = {}) {
  const apiKey = options.apiKey || process.env.COMPOSIO_API_KEY;
  if (apiKey && connectedAccountId) {
    const response = await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ connected_account_id: connectedAccountId, version: "latest", arguments: payload }),
    });
    const raw = await response.text();
    if (!response.ok || !raw) {
      throw new Error(`${tool} API request failed (HTTP ${response.status}): ${raw || "empty output"}`);
    }
    return resolveComposioResult(parseJson(raw, tool), tool);
  }
  return executeComposioCli(tool, account, payload, options);
}
