$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $ProjectRoot "tools"
$DnsxExe = Join-Path $ToolsDir "dnsx.exe"
$Version = if ($env:DNSX_VERSION) { $env:DNSX_VERSION } else { "1.3.1" }

Write-Host "== MX Preflight Windows setup ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20+ is required. Install Node.js from https://nodejs.org/ and rerun this script."
}

$NodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) { throw "Node.js 20+ is required. Current: $(node -v)" }

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

if (-not (Test-Path $DnsxExe)) {
    $Zip = Join-Path $ToolsDir "dnsx.zip"
    $Url = "https://github.com/projectdiscovery/dnsx/releases/download/v$Version/dnsx_${Version}_windows_amd64.zip"
    Write-Host "Downloading dnsx v$Version..."
    Invoke-WebRequest -Uri $Url -OutFile $Zip
    Expand-Archive -Path $Zip -DestinationPath $ToolsDir -Force
    Remove-Item $Zip -Force
}

Write-Host "dnsx:" -ForegroundColor DarkCyan
& $DnsxExe -version

Push-Location $ProjectRoot
try {
    if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
    Write-Host ""
    Write-Host "Setup complete." -ForegroundColor Green
    Write-Host "Run: .\scripts\run-local.ps1"
} finally {
    Pop-Location
}
