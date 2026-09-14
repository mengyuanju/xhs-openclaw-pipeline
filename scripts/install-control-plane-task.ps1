[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$TaskName = 'XhsOpenClawControlPlane',

  [switch]$RunAsSystem,

  [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-TaskArgument {
  param([string]$Value)
  if ($Value.Contains('"')) {
    throw 'Task argument paths must not contain double quotes.'
  }
  return '"' + $Value + '"'
}

if ($RunAsSystem -and -not (Test-IsAdministrator)) {
  throw 'Run PowerShell as Administrator to install the control plane as SYSTEM.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot 'run-control-plane-task.ps1'
$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop)[0]
$nodePath = $nodeCommand.Source
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($requiredPath in @($runnerPath, $nodePath, $powerShellPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required executable or script was not found: $requiredPath"
  }
}

$arguments = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  (Quote-TaskArgument $runnerPath),
  '-NodePath',
  (Quote-TaskArgument $nodePath),
  '-Environment',
  'production'
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $projectRoot
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

if ($RunAsSystem) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
  $mode = 'SYSTEM at computer startup'
}
else {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
  $mode = "$currentUser at sign-in"
}

$definition = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'XHS OpenClaw production control plane. Restarts automatically after failure.'

Register-ScheduledTask -TaskName $TaskName -InputObject $definition -Force | Out-Null

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
}

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $TaskName
  Mode = $mode
  State = $task.State
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  ProjectRoot = $projectRoot
  Logs = Join-Path $projectRoot 'server\logs'
}
