# Dot-sourced by install/update. Never called by the unprivileged HTTP service.
$certificateTaskName='KerioAccountSwitcher-CertificateSync'
function Set-CertificateDirectory([string]$InstallDir,[string]$ServiceSid) {
  $dir=Join-Path $InstallDir 'tls'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  foreach($id in 'S-1-5-18','S-1-5-32-544'){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  if($ServiceSid){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($ServiceSid),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath $dir -AclObject $acl
}
function Invoke-CertificateSync([string]$InstallDir) {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'windows\Sync-KerioCertificate.ps1') -InstallDir $InstallDir
  if($LASTEXITCODE -ne 0){throw 'Certificate sync failed; no service changes are needed to retry.'}
}
function New-CertificateTaskDefinition([string]$InstallDir) {
  if($InstallDir -match '["\r\n]'){throw 'Invalid installation path'}
  $script=Join-Path $InstallDir 'windows\Sync-KerioCertificate.ps1'
  $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$script+'" -InstallDir "'+$InstallDir+'"')
  $triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
  $principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 45) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  return New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Publish the validated active Kerio TLS pair to the protected gateway snapshot. Keeps the previous snapshot on failure.'
}
function Register-CertificateTask([string]$InstallDir) {
  Register-ScheduledTask -TaskName $certificateTaskName -InputObject (New-CertificateTaskDefinition $InstallDir) -Force | Out-Null
}
function Remove-CertificateTask {
  if(Get-ScheduledTask -TaskName $certificateTaskName -ErrorAction SilentlyContinue){
    Stop-ScheduledTask -TaskName $certificateTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $certificateTaskName -Confirm:$false
  }
}
