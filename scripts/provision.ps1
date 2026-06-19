# Bastion one-time Cloudflare provisioning (run from the repo root).
# Creates the D1 database + R2 bucket, wires the D1 id into wrangler.toml,
# sets the Anthropic secret, applies migrations, and deploys.
#
# Prereqs: `npm install` done; `npx wrangler login` (or CLOUDFLARE_API_TOKEN env).
# Reads CLOUDFLARE_* / ANTHROPIC_API_KEY from .env if present.

$ErrorActionPreference = "Stop"

if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([A-Z_]+)\s*=\s*(.+)\s*$") {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

Write-Host "==> Creating D1 database 'bastion' (ignore error if it already exists)"
$d1 = npx wrangler d1 create bastion 2>&1 | Out-String
Write-Host $d1
# Extract database_id from the output and patch wrangler.toml
if ($d1 -match 'database_id\s*=\s*"([0-9a-f-]+)"') {
  $id = $matches[1]
  (Get-Content wrangler.toml) -replace 'REPLACE_WITH_D1_DATABASE_ID', $id | Set-Content wrangler.toml -Encoding utf8
  Write-Host "==> Patched wrangler.toml with D1 id $id"
} else {
  Write-Host "!! Could not auto-detect D1 id — set database_id in wrangler.toml manually."
}

Write-Host "==> Creating R2 bucket 'bastion-storage' (ignore error if it already exists)"
try { npx wrangler r2 bucket create bastion-storage } catch { Write-Host $_ }

Write-Host "==> Setting ANTHROPIC_API_KEY secret"
if ($env:ANTHROPIC_API_KEY) {
  $env:ANTHROPIC_API_KEY | npx wrangler secret put ANTHROPIC_API_KEY
} else {
  Write-Host "!! ANTHROPIC_API_KEY not in env — run: npx wrangler secret put ANTHROPIC_API_KEY"
}

Write-Host "==> Applying D1 migrations (remote)"
npx wrangler d1 migrations apply bastion --remote

Write-Host "==> Building SPA + deploying Worker"
npm run deploy

Write-Host "==> Done. Now add a Cloudflare Access policy for bastion.clydeford.net"
Write-Host "    allowing only stevie.johnston@gmail.com (see README)."
