param([switch]$Rebuild, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 22.12+ first.' }
$canvasArgs = @('scripts/start.cjs')
if ($Rebuild) { $canvasArgs += '--rebuild' }
if ($NoOpen) { $canvasArgs += '--no-open' }
& node @canvasArgs
exit $LASTEXITCODE
