#requires -Version 5.1
#requires -RunAsAdministrator
param([string]$InstallDir='C:\Program Files\Kerio Account Switcher')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Certificate-Task.ps1')
$package=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if($InstallDir -eq $package -or $InstallDir.StartsWith('\\')){throw 'Extract the new package to a separate local folder.'}
$statePath=Join-Path $InstallDir 'install-state.json'
$configPath=Join-Path $InstallDir 'config.json'
$state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if($state.status -ne 'installed' -or $state.version -notin @('1.0.0','1.0.1','1.0.2','1.0.3')){throw 'Expected an installed version 1.0.0 through 1.0.3.'}
if((Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json).version -ne '1.0.3'){throw 'Expected the 1.0.3 package.'}
$service=Get-CimInstance Win32_Service -Filter "Name='KerioAccountSwitcher'"
$expectedExe=Join-Path $InstallDir 'KerioAccountSwitcher.Service.exe'
if(-not $service -or $service.PathName.Trim() -ne ('"'+$expectedExe+'"') -or $service.StartName -ne 'NT SERVICE\KerioAccountSwitcher'){throw 'Service path/identity does not match this installation.'}
$files=@('server.mjs','core.mjs','tls.mjs','package.json','public/accounts.js','public/bridge.js','public/client.js','public/worker.js','public/start.js','windows/Manage-KerioSwitcher.ps1','windows/Certificate-Task.ps1','windows/Sync-KerioCertificate.ps1','windows/publish-certificate.mjs','windows/probe.mjs','windows/Update-1.0.3.ps1','README.md','README.en.md','CHANGELOG.md')
$manifest=Get-Content -LiteralPath (Join-Path $package 'package-manifest.json') -Raw | ConvertFrom-Json
foreach($file in $files){
  $entry=@($manifest | Where-Object {$_.path -eq $file})
  if($entry.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $package $file) -Algorithm SHA256).Hash -ne $entry[0].sha256){throw "Package hash mismatch: $file"}
}
$oldTask=Get-ScheduledTask -TaskName $certificateTaskName -ErrorAction SilentlyContinue
if($oldTask -and ($oldTask.Actions.Count -ne 1 -or $oldTask.Actions[0].Arguments -notlike ('*"'+(Join-Path $InstallDir 'windows\Sync-KerioCertificate.ps1')+'"*'))){throw 'Certificate task name is used by another installation.'}
$backup=Join-Path $InstallDir ('backup\update-1.0.3-'+[guid]::NewGuid().ToString('N'))
# Protect rollback metadata and any previous TLS snapshot from non-admin readers.
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$backupAcl=[Security.AccessControl.DirectorySecurity]::new();$backupAcl.SetAccessRuleProtection($true,$false)
foreach($id in 'S-1-5-18','S-1-5-32-544'){$backupAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $backup -AclObject $backupAcl
$metadata=@('config.json','install-state.json','tls/active.json')
$existing=@()
foreach($file in ($files+$metadata)){
  New-Item -ItemType Directory -Path (Split-Path (Join-Path $backup $file) -Parent) -Force | Out-Null
  if(Test-Path -LiteralPath (Join-Path $InstallDir $file) -PathType Leaf){$existing+=$file;Copy-Item -LiteralPath (Join-Path $InstallDir $file) -Destination (Join-Path $backup $file)}
}
$oldTaskXml=$null
if($oldTask){$oldTaskXml=Export-ScheduledTask -TaskName $certificateTaskName;$oldTaskXml | Set-Content -LiteralPath (Join-Path $backup 'certificate-task.xml') -Encoding UTF8}
$key='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KerioAccountSwitcher'
$previousDisplayVersion=(Get-ItemProperty -LiteralPath $key).DisplayVersion
$wasRunning=$service.State -eq 'Running';$restarted=$false
try {
  if($oldTask){Remove-CertificateTask}
  foreach($file in $files){Copy-Item -LiteralPath (Join-Path $package $file) -Destination (Join-Path $InstallDir $file) -Force}
  Set-CertificateDirectory $InstallDir $state.serviceSid
  $config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $config.tls=[pscustomobject]@{bundlePath=(Join-Path $InstallDir 'tls\active.json')}
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Invoke-CertificateSync $InstallDir
  Register-CertificateTask $InstallDir
  # Do all certificate work before interrupting the existing HTTPS listener.
  $restarted=$true
  Stop-Service KerioAccountSwitcher
  (Get-Service KerioAccountSwitcher).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
  Start-Service KerioAccountSwitcher
  $node=Join-Path $InstallDir 'runtime\node.exe'
  $ready=$false
  for($attempt=0;$attempt -lt 5;$attempt++){
    & $node (Join-Path $InstallDir 'windows\probe.mjs') $configPath gateway
    if($LASTEXITCODE -eq 0){$ready=$true;break}
    Start-Sleep -Seconds 2
  }
  if(-not $ready){throw 'Updated module did not pass the HTTPS probe.'}
  $state.version='1.0.3'
  $state | Add-Member -NotePropertyName certificateTask -NotePropertyValue $certificateTaskName -Force
  $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath -Encoding UTF8
  Set-ItemProperty -LiteralPath $key -Name DisplayVersion -Value '1.0.3'
  Write-Output "UPDATED: 1.0.3; backup: $backup"
  Write-Output 'KerioMailServer was not restarted. Active TLS certificate synchronization runs every minute.'
} catch {
  $failure=$_
  Remove-CertificateTask
  if($restarted){Stop-Service KerioAccountSwitcher -ErrorAction SilentlyContinue}
  foreach($file in ($files+$metadata)){
    if($file -in $existing){Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $InstallDir $file) -Force}
    elseif(Test-Path -LiteralPath (Join-Path $InstallDir $file)){Remove-Item -LiteralPath (Join-Path $InstallDir $file)}
  }
  if($oldTaskXml){Register-ScheduledTask -TaskName $certificateTaskName -Xml $oldTaskXml -Force | Out-Null}
  Set-ItemProperty -LiteralPath $key -Name DisplayVersion -Value $previousDisplayVersion
  if($restarted -and $wasRunning){Start-Service KerioAccountSwitcher}
  throw $failure
}
