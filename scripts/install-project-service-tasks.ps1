[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-TaskArgument {
  param([string]$Value)
  if ($Value.Contains('"')) {
    throw 'Task argument paths must not contain double quotes.'
  }
  return '"' + $Value + '"'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot 'run-project-service-task.ps1'
$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop)[0]
$nodePath = $nodeCommand.Source
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($requiredPath in @($runnerPath, $nodePath, $powerShellPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required executable or script was not found: $requiredPath"
  }
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

$services = @(
  [pscustomobject]@{
    Service = 'web'
    TaskName = 'XhsOpenClawWeb'
    Description = 'XHS OpenClaw production web interface on port 3001.'
  },
  [pscustomobject]@{
    Service = 'xhs-search'
    TaskName = 'XhsOpenClawSearch'
    Description = 'XHS OpenClaw Xiaohongshu search worker using the signed-in user profile.'
  }
)

$results = foreach ($service in $services) {
  $arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (Quote-TaskArgument $runnerPath),
    '-Service',
    $service.Service,
    '-NodePath',
    (Quote-TaskArgument $nodePath)
  ) -join ' '
  $action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument $arguments `
    -WorkingDirectory $projectRoot
  $definition = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $service.Description

  Register-ScheduledTask -TaskName $service.TaskName -InputObject $definition -Force | Out-Null
  $task = Get-ScheduledTask -TaskName $service.TaskName
  $info = Get-ScheduledTaskInfo -TaskName $service.TaskName
  [pscustomobject]@{
    TaskName = $service.TaskName
    Service = $service.Service
    State = $task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
  }
}

$results
Write-Output "Logs: $(Join-Path $projectRoot 'service-logs')"
