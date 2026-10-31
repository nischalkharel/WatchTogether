# Runs Watch Together on this PC and shares it on the internet through
# Tailscale Funnel. The site is online only while this window is open:
# close it (or press Ctrl+C) to take the site offline.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$port = 3000

# This PC's permanent Tailscale address, e.g. mypc.tailXXXX.ts.net
$name = "$((& $ts status --json | ConvertFrom-Json).Self.DNSName)".TrimEnd('.')
if (-not $name) { throw 'Tailscale is not signed in. Open Tailscale, sign in, then run this again.' }

if (-not (Test-Path 'node_modules\ws')) { npm install --omit=dev --no-audit --no-fund }

# Private settings such as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET live in a
# .env file next to this script (KEY=value per line). Git ignores it.
if (Test-Path '.env') {
  foreach ($line in Get-Content '.env') {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      Set-Item "env:$($Matches[1])" $Matches[2].Trim('"', "'")
    }
  }
}

# Or the client_secret_*.json file downloaded from Google Cloud, dropped in
# this folder as-is. Git ignores it too.
$googleJson = Get-ChildItem -Filter 'client_secret*.json' | Select-Object -First 1
if (-not $env:GOOGLE_CLIENT_ID -and $googleJson) {
  $web = (Get-Content $googleJson.FullName -Raw | ConvertFrom-Json).web
  $env:GOOGLE_CLIENT_ID = $web.client_id
  $env:GOOGLE_CLIENT_SECRET = $web.client_secret
}

$env:NODE_ENV = 'production'
$env:PUBLIC_URL = "https://$name"
$env:TRUST_PROXY = '1'      # Funnel sits in front and passes on the visitor's address
$env:HOST = '127.0.0.1'     # only reachable through Funnel, not from your local network
$env:PORT = "$port"

$server = Start-Process node -ArgumentList 'server.js' -NoNewWindow -PassThru
try {
  Write-Host ""
  Write-Host "Watch Together is online at: https://$name" -ForegroundColor Green
  Write-Host "Keep this window open while you watch. Close it to go offline."
  Write-Host ""
  & $ts funnel $port   # stays running; sharing stops when it does
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
