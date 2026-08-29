import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const approvedRawCallers = new Set([
  "scripts/lib/composio.mjs",
  "scripts/composio-execute.sh",
  "scripts/audit-composio-callers.mjs",
]);

async function filesIn(directory) {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(relativePath));
    if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

const candidates = [
  ...(await filesIn("scripts")),
  ...(await filesIn(".github/workflows")),
].filter((file) => /\.(?:m?js|sh|ya?ml)$/.test(file));

const violations = [];
for (const file of candidates) {
  if (approvedRawCallers.has(file)) continue;
  const source = await fs.readFile(path.join(root, file), "utf8");
  const hasRawShellCall = /(?:["']?\$\{?COMPOSIO\}?["']?|["']?composio["']?)\s+execute\b/i.test(source);
  const hasRawNodeCall = /spawnSync[\s\S]{0,300}?["']execute["']/m.test(source);
  if (hasRawShellCall || hasRawNodeCall) violations.push(file);
}

if (violations.length > 0) {
  console.error("Raw Composio execute call(s) bypass the shared output resolver:");
  for (const file of violations) console.error(`- ${file}`);
  console.error("Node callers must use scripts/lib/composio.mjs; workflows must use scripts/composio-execute.sh.");
  process.exit(1);
}

console.log(`Composio caller audit passed (${candidates.length} executable/workflow files checked).`);
