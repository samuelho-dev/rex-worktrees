import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
const [packed] = JSON.parse(readFileSync("pack.json", "utf8"));
if (metadata.name !== "rex-worktrees" || packed.name !== metadata.name || packed.version !== metadata.version ||
    process.env.GITHUB_REF_NAME !== `v${metadata.version}` || basename(packed.filename) !== packed.filename) {
  throw new Error("Package identity does not match the release tag");
}
const integrity = `sha512-${createHash("sha512").update(readFileSync(packed.filename)).digest("base64")}`;
if (packed.integrity !== integrity) throw new Error("Packed archive integrity mismatch");
const expectedFiles = ["package.json", "README.md", "LICENSE", "licenses/THIRD-PARTY-NOTICES", "dist/rex-worktrees", "dist/rex-worktrees.js"].sort();
if (JSON.stringify(packed.files.map(file => file.path).sort()) !== JSON.stringify(expectedFiles)) {
  throw new Error("Unexpected npm package contents");
}
if (process.argv.includes("--dry-run")) {
  execFileSync("npm", ["publish", packed.filename, "--dry-run", "--ignore-scripts", "--access", "public"], { stdio: "inherit" });
  process.exit(0);
}
if (process.env.GITHUB_REPOSITORY !== "samuelho-dev/rex-worktrees" ||
    process.env.GITHUB_REF !== `refs/tags/v${metadata.version}` ||
    process.env.GITHUB_WORKFLOW_REF !== `samuelho-dev/rex-worktrees/.github/workflows/release.yml@refs/tags/v${metadata.version}` ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw new Error("Publishing requires GitHub Actions OIDC; local tokens are not supported");
}
const url = `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${metadata.version}`;
const lookup = async () => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
  return response.json();
};
const verify = record => {
  if (record.name !== metadata.name || record.version !== metadata.version || record.dist?.integrity !== integrity) {
    throw new Error("Registry package does not match the accepted archive");
  }
};
const existing = await lookup();
if (existing) {
  verify(existing);
  console.log(`${metadata.name}@${metadata.version} already contains the accepted archive`);
} else {
  const directory = mkdtempSync(join(tmpdir(), "rex-npm-auth-"));
  try {
    const userConfig = join(directory, "user.npmrc"), globalConfig = join(directory, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    execFileSync("npm", ["publish", packed.filename, "--ignore-scripts", "--access", "public", "--provenance", "--registry=https://registry.npmjs.org"], {
      stdio: "inherit",
      env: { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  let published;
  for (let attempt = 0; attempt < 6; attempt++) {
    published = await lookup();
    if (published) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!published) throw new Error("Published version is not visible in the registry");
  verify(published);
  console.log(`Verified ${metadata.name}@${metadata.version}: ${integrity}`);
}
