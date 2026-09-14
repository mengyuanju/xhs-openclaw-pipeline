[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('web', 'xhs-search')]
  [string]$Service,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$NodePath,

  [ValidateRange(1, 365)]
  [int]$LogRetentionDays = 14
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot 'service-logs'

switch ($Service) {
  'web' {
    $workingDirectory = $projectRoot
    $entryPath = Join-Path $projectRoot 'node_modules\next\dist\bin\next'
    $nodeArguments = @($entryPath, 'start', '-H', '0.0.0.0', '-p', '3001')
  }
  'xhs-search' {
    $workingDirectory = $projectRoot
    $entryPath = Join-Path $projectRoot 'src\executor\xhs-search-cli.mjs'
    $nodeArguments = @('--env-file-if-exists=.env', $entryPath)
  }
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Node.js executable was not found: $NodePath"
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "Service entry file was not found: $entryPath"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$retentionCutoff = (Get-Date).AddDays(-$LogRetentionDays)
Get-ChildItem -LiteralPath $logDirectory -Filter "$Service-*.log" -File -ErrorAction SilentlyContinue |
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
  $logPath = Join-Path $logDirectory "$Service-$date.log"
  $script:writer = New-Object System.IO.StreamWriter($logPath, $true, $utf8WithoutBom)
  $script:writer.AutoFlush = $true
  $script:writerDate = $date
  return $script:writer
}

try {
  $startedAt = Get-Date
  (Get-DailyLogWriter $startedAt).WriteLine(
    "[$($startedAt.ToString('o'))] scheduled task starting $Service"
  )

  Push-Location $workingDirectory
  try {
    & $NodePath @nodeArguments 2>&1 |
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
    $writer.WriteLine("[$($stoppedAt.ToString('o'))] $Service exited with code $exitCode")
    $writer.Dispose()
  }
}

exit $exitCode
