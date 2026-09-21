[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$TaskName = 'XhsOpenClawControlPlane'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "Scheduled task '$TaskName' is not installed."
  exit 0
}

if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Scheduled task '$TaskName' was removed. Existing log files were kept."
