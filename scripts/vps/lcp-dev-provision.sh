#!/usr/bin/env bash
# Run as agent, never root. Pinned, workspace-local tools; no global installs.
set -euo pipefail
[[ "$(id -u)" != 0 ]]
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$src/lcp-dev-env.sh"
npm install --prefix "$LCP_DEV_CACHE/tools" --no-audit --no-fund --ignore-scripts pnpm@11.1.3 playwright@1.65.1
pnpm --version
playwright install chromium
node - "$LCP_DEV_CACHE" <<'JS'
const {chromium}=require(process.argv[2]+"/tools/node_modules/playwright");
(async()=>{const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();
  await page.setContent("<title>Browser smoke</title><h1>OK</h1>");
  if(await page.locator("h1").textContent()!=="OK") throw Error("browser failed");
  console.log("Chromium smoke passed");
}finally{await browser.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
JS
