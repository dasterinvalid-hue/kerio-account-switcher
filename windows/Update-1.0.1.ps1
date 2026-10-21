#requires -Version 5.1
#requires -RunAsAdministrator
param([string]$InstallDir='C:\Program Files\Kerio Account Switcher')
$ErrorActionPreference='Stop'
$package=Split-Path $PSScriptRoot -Parent
$InstallDir=[IO.Path]::GetFullPath($InstallDir)
if($InstallDir.TrimEnd('\') -eq $package.TrimEnd('\')){throw 'Extract the new package to a separate folder.'}
$statePath=Join-Path $InstallDir 'install-state.json'
$state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if($state.status -ne 'installed' -or $state.version -notin @('1.0.0','1.0.1')){throw 'This patch requires an installed version 1.0.0 or 1.0.1.'}
$packageInfo=Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json
if($packageInfo.version -ne '1.0.1'){throw 'Expected the 1.0.1 package.'}
$service=Get-CimInstance Win32_Service -Filter "Name='KerioAccountSwitcher'"
$expectedExe=Join-Path $InstallDir 'KerioAccountSwitcher.Service.exe'
if(-not $service -or -not $service.PathName.TrimStart().StartsWith(('"'+$expectedExe+'"'),[StringComparison]::OrdinalIgnoreCase)){throw 'Service path does not match InstallDir.'}
if($service.State -ne 'Running'){throw 'Start the installed module before applying this patch.'}
$files=@('server.mjs','package.json','public/worker.js','public/start.js','README.md')
$manifest=Get-Content -LiteralPath (Join-Path $package 'package-manifest.json') -Raw | ConvertFrom-Json
foreach($file in $files){
  $entry=@($manifest | Where-Object {$_.path -eq $file})
  if($entry.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $package $file)).Hash -ne $entry[0].sha256){throw "Package hash mismatch: $file"}
  if(-not (Test-Path -LiteralPath (Join-Path $InstallDir $file) -PathType Leaf)){throw "Installed file missing: $file"}
}
$backup=Join-Path $InstallDir ('backup\update-1.0.1-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $backup 'public') -Force | Out-Null
$metadata=@('install-state.json')
foreach($file in ($files+$metadata)){Copy-Item -LiteralPath (Join-Path $InstallDir $file) -Destination (Join-Path $backup $file)}
$key='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KerioAccountSwitcher'
$previousDisplayVersion=(Get-ItemProperty -LiteralPath $key).DisplayVersion
$restart=@($files | Where-Object {$_ -ne 'README.md' -and (Get-FileHash -LiteralPath (Join-Path $package $_)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $InstallDir $_)).Hash}).Count -gt 0
try{
  if($restart){Stop-Service KerioAccountSwitcher}
  foreach($file in $files){Copy-Item -LiteralPath (Join-Path $package $file) -Destination (Join-Path $InstallDir $file) -Force}
  if($restart){Start-Service KerioAccountSwitcher}
  $node=Join-Path $InstallDir 'runtime\node.exe'
  $probe=Join-Path $InstallDir 'windows\probe.mjs'
  $config=Join-Path $InstallDir 'config.json'
  $ready=$false
  for($attempt=0;$attempt -lt 5;$attempt++){
    & $node $probe $config gateway
    if($LASTEXITCODE -eq 0){$ready=$true;break}
    Start-Sleep -Seconds 2
  }
  if(-not $ready){throw 'Updated module did not pass the HTTPS probe.'}
  $state.version='1.0.1'
  $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath -Encoding UTF8
  Set-ItemProperty -LiteralPath $key -Name DisplayVersion -Value '1.0.1'
  Write-Output "UPDATED: 1.0.1; backup: $backup"
  Write-Output 'KerioMailServer was not restarted. Reopen the browser to replace an old worker.'
}catch{
  $failure=$_
  if($restart){Stop-Service KerioAccountSwitcher -ErrorAction SilentlyContinue}
  foreach($file in ($files+$metadata)){Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $InstallDir $file) -Force}
  Set-ItemProperty -LiteralPath $key -Name DisplayVersion -Value $previousDisplayVersion
  if($restart){Start-Service KerioAccountSwitcher}
  throw $failure
}
