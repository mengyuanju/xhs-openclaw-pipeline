[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($taskName in @('XhsOpenClawWeb', 'XhsOpenClawSearch')) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output "Scheduled task '$taskName' is not installed."
    continue
  }
  if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Scheduled task '$taskName' was removed."
}

Write-Output 'Existing log files were kept.'
