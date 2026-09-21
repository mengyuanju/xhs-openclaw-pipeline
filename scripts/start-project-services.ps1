[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-HttpHealth {
  param(
    [string]$Uri,
    [switch]$RequireDataOk
  )
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
    if ($RequireDataOk) {
      $payload = $response.Content | ConvertFrom-Json
      return $payload.data.ok -eq $true
    }
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  }
  catch {
    return $false
  }
}

function Test-SearchProcess {
  return [bool](Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object CommandLine -Match 'src[\\/]executor[\\/]xhs-search-cli\.mjs' |
    Select-Object -First 1)
}

$services = @(
  [pscustomobject]@{
    Name = 'Control plane'
    TaskName = 'XhsOpenClawControlPlane'
    Test = { Test-HttpHealth -Uri 'http://127.0.0.1:4310/health' -RequireDataOk }
  },
  [pscustomobject]@{
    Name = 'Web interface'
    TaskName = 'XhsOpenClawWeb'
    Test = { Test-HttpHealth -Uri 'http://127.0.0.1:3001/' }
  },
  [pscustomobject]@{
    Name = 'Xiaohongshu search'
    TaskName = 'XhsOpenClawSearch'
    Test = { Test-SearchProcess }
  }
)

$failed = $false
foreach ($service in $services) {
  Write-Output "Checking $($service.Name)..."
  if (& $service.Test) {
    Write-Output "[OK] $($service.Name) is already running."
    continue
  }

  $task = Get-ScheduledTask -TaskName $service.TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output "[FAILED] Scheduled task not found: $($service.TaskName)"
    $failed = $true
    continue
  }

  Start-ScheduledTask -TaskName $service.TaskName
  $ready = $false
  foreach ($attempt in 1..30) {
    Start-Sleep -Seconds 1
    if (& $service.Test) {
      $ready = $true
      break
    }
  }
  if ($ready) {
    Write-Output "[OK] $($service.Name) started successfully."
  }
  else {
    Write-Output "[FAILED] $($service.Name) did not become ready within 30 seconds."
    $failed = $true
  }
}

if ($failed) {
  Write-Output "Check logs in: $(Join-Path (Split-Path -Parent $PSScriptRoot) 'service-logs')"
  exit 1
}

Write-Output 'All configured services are running.'
