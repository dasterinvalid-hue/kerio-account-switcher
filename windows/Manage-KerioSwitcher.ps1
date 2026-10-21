#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('Install','Uninstall','Status')][string]$Mode='Install',
  [string]$HostName,
  [string]$KerioPath='C:\Program Files\Kerio\MailServer',
  [string]$InstallDir='C:\Program Files\Kerio Account Switcher',
  [ValidateRange(1024,65535)][int]$BackendPort=8843
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$serviceName='KerioAccountSwitcher'
$statePath=Join-Path $InstallDir 'install-state.json'
function Assert-Admin {
  $p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer as administrator.'}
}
function Set-ProtectedDirectory([string]$Path) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in 'S-1-5-18','S-1-5-32-544'){
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Read-ConfigXml([string]$Path) {
  $xml=[xml]::new();$xml.PreserveWhitespace=$true;$xml.Load($Path);return ,$xml
}
function Save-ConfigXml($Xml,[string]$Path) {
  $tmp=$Path+'.kas-new'
  $Xml.Save($tmp)
  $previous=$Path+'.kas-previous'
  [IO.File]::Replace($tmp,$Path,$previous)
  Remove-Item -LiteralPath $previous -Force
}
function Wait-ServiceState([string]$Name,[string]$Status) {
  (Get-Service -Name $Name).WaitForStatus([ServiceProcess.ServiceControllerStatus]::$Status,[TimeSpan]::FromSeconds(90))
}
function Write-State($State) { $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding UTF8 }
function Listener-Key($Items) {
  return (@($Items | ForEach-Object { $n=[xml]$_; '{0}:{1}' -f $n.SelectSingleNode('//variable[@name="IPAddress"]').InnerText,$n.SelectSingleNode('//variable[@name="Port"]').InnerText }) | Sort-Object) -join ';'
}
function Remove-ServiceAcls($State) {
  foreach($path in $State.aclPaths){
    if(Test-Path $path){$acl=Get-Acl -LiteralPath $path;foreach($ace in @($acl.Access)){
      try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{continue}
      if($sid -eq $State.serviceSid){[void]$acl.RemoveAccessRuleSpecific($ace)}
    };Set-Acl -LiteralPath $path -AclObject $acl}
  }
}
function Native-Check([string]$Node,[string]$Config,[string]$Kind) {
  & $Node (Join-Path $InstallDir 'windows\probe.mjs') $Config $Kind
  if($LASTEXITCODE -ne 0){throw "Verification failed: $Kind"}
}
function Restore-Https($State) {
  $cfgPath=Join-Path $State.kerioPath 'mailserver.cfg'
  $xml=Read-ConfigXml $cfgPath
  $list=$xml.SelectSingleNode('/config/list[@name="ServicePorts"]')
  $current=@($list.SelectNodes('listitem[variable[@name="Service"]="HTTPS"]'))
  foreach($item in $current){[void]$list.RemoveChild($item)}
  foreach($item in $State.originalHttps){$fragment=$xml.CreateDocumentFragment();$fragment.InnerXml=$item;[void]$list.AppendChild($fragment)}
  $port=$xml.SelectSingleNode('/config/table[@name="service-https"]/variable[@name="Port"]')
  if($port -and $null -ne $State.originalDefaultPort){$port.InnerText=[string]$State.originalDefaultPort}
  foreach($name in 'UseProxiedInfo','TrustedProxyAddressGroup'){
    $v=$xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="'+$name+'"]')
    if($v){$v.InnerText=[string]$State.originalProxy.$name}
  }
  $proxyItem=$xml.SelectSingleNode('/config/list[@name="IpAccessList"]/listitem[variable[@name="Guid"]="'+$State.proxyItemGuid+'"]')
  if($proxyItem){[void]$proxyItem.ParentNode.RemoveChild($proxyItem)}
  Save-ConfigXml $xml $cfgPath
}
function Remove-ServiceRegistration {
  if(Get-Service $serviceName -ErrorAction SilentlyContinue){
    Stop-Service $serviceName -ErrorAction SilentlyContinue
    & sc.exe delete $serviceName | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Cannot delete gateway service'}
  }
  Get-NetFirewallRule -Name 'KerioAccountSwitcher-HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

if($Mode -eq 'Status'){
  Get-Service KerioMailServer,$serviceName -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType
  if(Test-Path $statePath){Get-Content $statePath -Raw}
  exit 0
}
Assert-Admin
if($Mode -eq 'Uninstall'){
  if(-not(Test-Path $statePath)){throw 'Installation state is missing; cannot safely restore Kerio listeners.'}
  $state=Get-Content $statePath -Raw | ConvertFrom-Json
  if($state.status -eq 'uninstalled'){Write-Output 'Already uninstalled.';exit 0}
  $xml=Read-ConfigXml (Join-Path $state.kerioPath 'mailserver.cfg')
  $actual=@($xml.SelectNodes('/config/list[@name="ServicePorts"]/listitem[variable[@name="Service"]="HTTPS"]') | ForEach-Object OuterXml)
  if((Listener-Key $actual) -ne (Listener-Key $state.appliedHttps)){throw 'HTTPS listeners were changed after installation. Restore them manually in Kerio before removing the module; no changes made.'}
  Write-Output 'Restoring original Kerio HTTPS listeners; briefly restarting Kerio.'
  Stop-Service $serviceName -ErrorAction SilentlyContinue
  Stop-Service KerioMailServer;Wait-ServiceState KerioMailServer Stopped
  try{Restore-Https $state}finally{Start-Service KerioMailServer;Wait-ServiceState KerioMailServer Running}
  # Remove only ACEs owned by our virtual service identity.
  Remove-ServiceAcls $state
  Remove-ServiceRegistration
  $state.status='uninstalled';Write-State $state
  $uninstallKey='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KerioAccountSwitcher'
  if(Test-Path $uninstallKey){Remove-Item -LiteralPath $uninstallKey}
  Write-Output 'Uninstalled. Original HTTPS listeners restored. Protected backup and logs are retained.'
  exit 0
}

if(-not $HostName -or $HostName -notmatch '^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$' -or $HostName.Contains('..')){throw 'Specify the public DNS hostname without https:// or a path.'}
$HostName=$HostName.ToLowerInvariant()
$KerioPath=[IO.Path]::GetFullPath($KerioPath).TrimEnd('\')
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if($InstallDir.StartsWith('\\') -or $InstallDir.Length -lt 12 -or $InstallDir -eq $KerioPath){throw 'Invalid installation directory'}
if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw 'Module is already installed. Uninstall it before installing this release.'}
if(Test-Path $statePath){throw 'This directory already contains installation state. Use a new directory or follow the update instructions.'}
$cfgPath=Join-Path $KerioPath 'mailserver.cfg'
$xml=Read-ConfigXml $cfgPath
$proxyEnabled=$xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="UseProxiedInfo"]')
$proxyGroup=$xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="TrustedProxyAddressGroup"]')
if(-not $proxyEnabled -or -not $proxyGroup){throw 'This Kerio version lacks trusted proxy configuration. No changes made.'}
if($proxyEnabled.InnerText -ne '0' -or $proxyGroup.InnerText){throw 'Kerio already has proxy configuration. Integrate manually; automatic installation will not replace it.'}
$httpsItems=@($xml.SelectNodes('/config/list[@name="ServicePorts"]/listitem[variable[@name="Service"]="HTTPS"]'))
if(-not @($httpsItems | Where-Object { $_.SelectSingleNode('variable[@name="Port"]').InnerText -eq '443' }).Count){throw 'Kerio must currently own HTTPS port 443.'}
$kerioService=Get-CimInstance Win32_Service -Filter "Name='KerioMailServer'"
if($kerioService.State -ne 'Running'){throw 'KerioMailServer must be running before installation.'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue)
if(-not $listeners.Count -or @($listeners | Where-Object OwningProcess -ne $kerioService.ProcessId).Count){throw 'Port 443 is not owned exclusively by Kerio.'}
$backendListeners=@(Get-NetTCPConnection -State Listen -LocalPort $BackendPort -ErrorAction SilentlyContinue)
if(@($backendListeners | Where-Object OwningProcess -ne $kerioService.ProcessId).Count){throw 'The requested backend port is occupied by another process.'}
$packageRoot=Split-Path $PSScriptRoot -Parent
if(Test-Path (Join-Path $packageRoot 'package-manifest.json')){
  $manifest=Get-Content (Join-Path $packageRoot 'package-manifest.json') -Raw | ConvertFrom-Json
  foreach($entry in $manifest){
    $file=[IO.Path]::GetFullPath((Join-Path $packageRoot $entry.path))
    if(-not $file.StartsWith($packageRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid manifest path'}
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Package checksum mismatch: '+$entry.path)}
  }
}
foreach($file in 'runtime\node.exe','KerioAccountSwitcher.Service.exe','server.mjs','core.mjs','public\client.js'){
  if(-not(Test-Path (Join-Path $packageRoot $file))){throw "Package file missing: $file"}
}
Set-ProtectedDirectory $InstallDir
Set-ProtectedDirectory (Join-Path $InstallDir 'backup')
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'logs') -Force | Out-Null
foreach($file in 'server.mjs','core.mjs','package.json','README.md','LICENSE','KerioAccountSwitcher.Service.exe'){
  Copy-Item -LiteralPath (Join-Path $packageRoot $file) -Destination $InstallDir
}
foreach($dir in 'runtime','public','windows'){
  Copy-Item -LiteralPath (Join-Path $packageRoot $dir) -Destination $InstallDir -Recurse
}
$longPoll=$xml.SelectSingleNode('//variable[@name="LongPollTimeout"]')
$config=[ordered]@{publicOrigin="https://$HostName";upstreamOrigin="https://${HostName}:$BackendPort";connectAddress='127.0.0.1';listenAddress='0.0.0.0';listenPort=443;kerioLongPollSeconds=600;tls=@{certPath=(Join-Path $KerioPath 'sslcert\server.crt');keyPath=(Join-Path $KerioPath 'sslcert\server.key')}}
if($longPoll){$config.kerioLongPollSeconds=[int]$longPoll.InnerText}
$configPath=Join-Path $InstallDir 'config.json'
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
$node=Join-Path $InstallDir 'runtime\node.exe'
Native-Check $node $configPath certificate
if($backendListeners.Count){Native-Check $node $configPath upstream}
$originalPort=$xml.SelectSingleNode('/config/table[@name="service-https"]/variable[@name="Port"]')
$state=[ordered]@{version='1.0.1';status='preparing';kerioPath=$KerioPath;hostName=$HostName;backendPort=$BackendPort;originalHttps=@($httpsItems|ForEach-Object OuterXml);originalDefaultPort=$(if($originalPort){$originalPort.InnerText}else{$null});originalProxy=@{UseProxiedInfo=$proxyEnabled.InnerText;TrustedProxyAddressGroup=$proxyGroup.InnerText};proxyItemGuid=[guid]::NewGuid().ToString();appliedHttps=@();serviceSid='';aclPaths=@();installedUtc=[DateTime]::UtcNow.ToString('o')}
Write-State $state
$changed=$false;$stopped=$false
try {
  Write-Output 'Preflight passed. Restarting Kerio to free HTTPS port 443.'
  Stop-Service KerioMailServer;Wait-ServiceState KerioMailServer Stopped;$stopped=$true
  # Read again after shutdown: Kerio may save its final configuration while stopping.
  Copy-Item -LiteralPath $cfgPath -Destination (Join-Path $InstallDir 'backup\mailserver.cfg')
  $xml=Read-ConfigXml $cfgPath
  $list=$xml.SelectSingleNode('/config/list[@name="ServicePorts"]')
  $items=@($list.SelectNodes('listitem[variable[@name="Service"]="HTTPS"]'))
  $state.originalHttps=@($items|ForEach-Object OuterXml)
  $port=$xml.SelectSingleNode('/config/table[@name="service-https"]/variable[@name="Port"]')
  $state.originalDefaultPort=$(if($port){$port.InnerText}else{$null})
  foreach($item in $items){if($item.SelectSingleNode('variable[@name="Port"]').InnerText -eq '443'){[void]$list.RemoveChild($item)}}
  if(-not @($list.SelectNodes('listitem[variable[@name="Service"]="HTTPS"]') | Where-Object { $_.SelectSingleNode('variable[@name="Port"]').InnerText -eq [string]$BackendPort -and $_.SelectSingleNode('variable[@name="IPAddress"]').InnerText -in '0.0.0.0','127.0.0.1' }).Count){
    $item=$xml.CreateElement('listitem')
    foreach($pair in @(@('Service','HTTPS'),@('IPAddress','127.0.0.1'),@('Port',[string]$BackendPort))){$v=$xml.CreateElement('variable');$v.SetAttribute('name',$pair[0]);$v.InnerText=$pair[1];[void]$item.AppendChild($v)}
    [void]$list.AppendChild($item)
  }
  if($port){$port.InnerText=[string]$BackendPort}
  $proxyGroupName='KAS Proxy '+$state.proxyItemGuid.Substring(0,8)
  $aclList=$xml.SelectSingleNode('/config/list[@name="IpAccessList"]')
  $proxyItem=$xml.CreateElement('listitem')
  foreach($pair in @(@('Name',$proxyGroupName),@('Value','127.0.0.1'),@('Enabled','1'),@('Desc','Kerio Account Switcher loopback only'),@('Guid',$state.proxyItemGuid),@('GroupGuid',[guid]::NewGuid().ToString()),@('AppManagerId',''))){
    $v=$xml.CreateElement('variable');$v.SetAttribute('name',$pair[0]);$v.InnerText=$pair[1];[void]$proxyItem.AppendChild($v)
  }
  [void]$aclList.AppendChild($proxyItem)
  $xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="UseProxiedInfo"]').InnerText='1'
  $xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="TrustedProxyAddressGroup"]').InnerText=$proxyGroupName
  $state.appliedHttps=@($list.SelectNodes('listitem[variable[@name="Service"]="HTTPS"]') | ForEach-Object OuterXml)
  Write-State $state
  Save-ConfigXml $xml $cfgPath;$changed=$true
  Start-Service KerioMailServer;Wait-ServiceState KerioMailServer Running;$stopped=$false
  $ready=$false
  for($i=0;$i -lt 15;$i++){try{Native-Check $node $configPath upstream;$ready=$true;break}catch{Start-Sleep -Seconds 2}}
  if(-not $ready){throw 'Kerio backend did not become healthy.'}
  $serviceExe=Join-Path $InstallDir 'KerioAccountSwitcher.Service.exe'
  New-Service -Name $serviceName -BinaryPathName ('"'+$serviceExe+'"') -DisplayName 'Kerio Account Switcher' -StartupType Automatic -DependsOn KerioMailServer | Out-Null
  & sc.exe config $serviceName obj= "NT SERVICE\$serviceName" | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure service identity'}
  & sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot configure service recovery'}
  $sid=([Security.Principal.NTAccount]::new("NT SERVICE\$serviceName")).Translate([Security.Principal.SecurityIdentifier])
  $state.serviceSid=$sid.Value
  $acl=Get-Acl -LiteralPath $InstallDir
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $InstallDir -AclObject $acl
  $logs=Join-Path $InstallDir 'logs';$acl=Get-Acl -LiteralPath $logs
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $logs -AclObject $acl
  foreach($path in @((Join-Path $KerioPath 'sslcert'),$config.tls.certPath,$config.tls.keyPath)){
    $acl=Get-Acl -LiteralPath $path
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
    $state.aclPaths+=,$path;Write-State $state
  }
  New-NetFirewallRule -Name 'KerioAccountSwitcher-HTTPS' -DisplayName 'Kerio Account Switcher HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443 -Program $node -Profile Any | Out-Null
  Start-Service $serviceName;Wait-ServiceState $serviceName Running
  $ready=$false
  for($i=0;$i -lt 15;$i++){try{Native-Check $node $configPath gateway;$ready=$true;break}catch{Start-Sleep -Seconds 2}}
  if(-not $ready){throw 'Gateway did not become healthy.'}
  $state.status='installed';Write-State $state
  $uninstallKey='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KerioAccountSwitcher'
  New-Item -Path $uninstallKey -Force | Out-Null
  $properties=@{DisplayName='Kerio Account Switcher';DisplayVersion='1.0.1';Publisher='Kerio Account Switcher contributors';InstallLocation=$InstallDir;UninstallString=('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+$InstallDir+'\windows\Manage-KerioSwitcher.ps1" -Mode Uninstall -InstallDir "'+$InstallDir+'"')}
  foreach($name in $properties.Keys){New-ItemProperty -Path $uninstallKey -Name $name -Value $properties[$name] -PropertyType String -Force | Out-Null}
  Write-Output "INSTALLED: https://$HostName/webmail/"
  Write-Output "Rollback: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\windows\Manage-KerioSwitcher.ps1`" -Mode Uninstall -InstallDir `"$InstallDir`""
} catch {
  $failure=$_.Exception.Message
  Write-Warning "Installation failed: $failure. Rolling back."
  try {
    Remove-ServiceAcls ([pscustomobject]$state)
    Remove-ServiceRegistration
    if($changed){Stop-Service KerioMailServer;Wait-ServiceState KerioMailServer Stopped;Restore-Https ([pscustomobject]$state);$stopped=$true}
    if($stopped){Start-Service KerioMailServer;Wait-ServiceState KerioMailServer Running}
    $state.status='rolled-back';Write-State $state
  }catch{Write-Warning "Automatic rollback needs attention: $($_.Exception.Message)"}
  throw $failure
}
