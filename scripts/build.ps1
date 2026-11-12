# Cross-compiles MotherGoose for Windows, macOS and Linux into dist\.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build.ps1 [version]
param([string]$Version = (Get-Date -Format "yyyy.MM.dd"))
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path dist | Out-Null
$env:CGO_ENABLED = "0"
foreach ($t in "windows/amd64","windows/arm64","darwin/arm64","darwin/amd64","linux/amd64","linux/arm64") {
  $os, $arch = $t.Split("/")
  $out = "dist/mothergoose-$os-$arch"
  if ($os -eq "windows") { $out += ".exe" }
  Write-Host "building $out"
  $env:GOOS = $os; $env:GOARCH = $arch
  go build -trimpath -ldflags "-s -w -X main.version=$Version" -o $out ./cmd/mothergoose
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Remove-Item Env:GOOS, Env:GOARCH
Write-Host "done"
