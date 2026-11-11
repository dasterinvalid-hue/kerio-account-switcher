# Read-only: constructs an in-memory task definition, does not register a task.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Certificate-Task.ps1')
$def=New-CertificateTaskDefinition 'C:\Program Files\Kerio Account Switcher'
if($def.Triggers.Count -ne 2){throw 'Expected boot and interval triggers'}
$boot=@($def.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'})
$time=@($def.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger'})
if($boot.Count -ne 1 -or $time.Count -ne 1 -or $time[0].Repetition.Interval -ne 'PT1M' -or $time[0].Repetition.Duration){throw 'Task must repeat every minute indefinitely and at boot'}
$principalSid=([Security.Principal.NTAccount]::new([string]$def.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
if($principalSid -ne 'S-1-5-18' -or $def.Principal.LogonType -ne 5){throw 'Task must use SYSTEM without stored credentials'}
if($def.Settings.MultipleInstances -ne 2 -or $def.Settings.ExecutionTimeLimit -ne 'PT45S'){throw 'Task must not overlap and must have an execution limit'}
if($def.Actions[0].Arguments -notmatch '-File "C:\\Program Files\\Kerio Account Switcher\\windows\\Sync-KerioCertificate.ps1"'){throw 'Task arguments must quote paths with spaces'}
$rejected=$false
try{New-CertificateTaskDefinition 'C:\bad"path' | Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Unsafe path was accepted'}
Write-Output 'PASS: certificate task runs at boot and every minute as SYSTEM, has bounded execution and quoted paths. No task registered.'
