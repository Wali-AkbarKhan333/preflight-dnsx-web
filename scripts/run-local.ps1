$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {
    if (-not (Test-Path "tools\dnsx.exe")) {
        Write-Host "dnsx is missing; running setup first..." -ForegroundColor Yellow
        & ".\scripts\setup-windows.ps1"
    }
    if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
    Write-Host "Starting MX Preflight at http://localhost:3000" -ForegroundColor Cyan
    npm start
} finally {
    Pop-Location
}
