param([Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$disabledFile = Join-Path $projectRoot '.cache\local-service.disabled'
if (Test-Path -LiteralPath $disabledFile) { exit 0 }

$node = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).ProviderPath
$supervisor = Join-Path $projectRoot 'scripts\local-supervisor.cjs'
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
  throw 'The Draw studio local supervisor is missing.'
}

Set-Location -LiteralPath $projectRoot
& $node $supervisor
exit $LASTEXITCODE
