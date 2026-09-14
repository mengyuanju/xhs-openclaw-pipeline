[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$NodePath,

  [ValidateSet('development', 'production')]
  [string]$Environment = 'production',

  [ValidateRange(1, 365)]
  [int]$LogRetentionDays = 14
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $projectRoot 'server'
$entryPath = Join-Path $serverRoot 'src\cli.mjs'
$logDirectory = Join-Path $serverRoot 'logs'

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Node.js executable was not found: $NodePath"
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "Control-plane entry file was not found: $entryPath"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$retentionCutoff = (Get-Date).AddDays(-$LogRetentionDays)
Get-ChildItem -LiteralPath $logDirectory -Filter 'control-plane-*.log' -File -ErrorAction SilentlyContinue |
  Where-Object LastWriteTime -LT $retentionCutoff |
  Remove-Item -Force

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$writer = $null
$writerDate = $null
$exitCode = 1

function Get-DailyLogWriter {
  param([datetime]$Now)

  $date = $Now.ToString('yyyy-MM-dd')
  if ($script:writer -and $script:writerDate -eq $date) {
    return $script:writer
  }

  if ($script:writer) {
    $script:writer.Dispose()
  }
  $logPath = Join-Path $logDirectory "control-plane-$date.log"
  $script:writer = New-Object System.IO.StreamWriter($logPath, $true, $utf8WithoutBom)
  $script:writer.AutoFlush = $true
  $script:writerDate = $date
  return $script:writer
}

try {
  $startedAt = Get-Date
  (Get-DailyLogWriter $startedAt).WriteLine(
    "[$($startedAt.ToString('o'))] scheduled task starting control plane ($Environment)"
  )

  Push-Location $serverRoot
  try {
    & $NodePath $entryPath 'serve' "--environment=$Environment" 2>&1 |
      ForEach-Object {
        $now = Get-Date
        (Get-DailyLogWriter $now).WriteLine([string]$_)
      }
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
      $exitCode = 1
    }
  }
  finally {
    Pop-Location
  }
}
catch {
  $failedAt = Get-Date
  (Get-DailyLogWriter $failedAt).WriteLine(
    "[$($failedAt.ToString('o'))] scheduled task runner failed: $($_.Exception.Message)"
  )
  $exitCode = 1
}
finally {
  if ($writer) {
    $stoppedAt = Get-Date
    $writer.WriteLine("[$($stoppedAt.ToString('o'))] control plane exited with code $exitCode")
    $writer.Dispose()
  }
}

exit $exitCode
