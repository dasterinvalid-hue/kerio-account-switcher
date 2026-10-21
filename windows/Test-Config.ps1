$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Manage-KerioSwitcher.ps1'),[ref]$tokens,[ref]$errors)
if($errors){throw ($errors | Out-String)}
foreach($name in 'Read-ConfigXml','Save-ConfigXml','Restore-Https','Listener-Key'){
  $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false)
  Invoke-Expression $function.Extent.Text
}
$dir=Join-Path ([IO.Path]::GetTempPath()) ('KerioSwitcher-config-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
$path=Join-Path $dir 'mailserver.cfg'
@'
<config><table name="Http"><variable name="UseProxiedInfo">1</variable><variable name="TrustedProxyAddressGroup">KAS Test</variable></table><table name="service-https"><variable name="Port">8843</variable></table><table name="Other"><variable name="Keep">later-change</variable></table><list name="IpAccessList"><listitem><variable name="Guid">ours</variable></listitem><listitem><variable name="Guid">theirs</variable></listitem></list><list name="ServicePorts"><listitem><variable name="Service">SMTP</variable><variable name="IPAddress">0.0.0.0</variable><variable name="Port">25</variable></listitem><listitem><variable name="Service">HTTPS</variable><variable name="IPAddress">127.0.0.1</variable><variable name="Port">8843</variable></listitem></list></config>
'@ | Set-Content -LiteralPath $path -Encoding UTF8
try {
  $original='<listitem><variable name="Service">HTTPS</variable><variable name="IPAddress">0.0.0.0</variable><variable name="Port">443</variable></listitem>'
  $state=[pscustomobject]@{kerioPath=$dir;originalHttps=@($original);originalDefaultPort='443';originalProxy=@{UseProxiedInfo='0';TrustedProxyAddressGroup=''};proxyItemGuid='ours'}
  Restore-Https $state
  $xml=Read-ConfigXml $path
  if($xml.SelectSingleNode('/config/table[@name="Other"]/variable').InnerText -ne 'later-change'){throw 'Unrelated settings changed'}
  if($xml.SelectNodes('/config/list[@name="ServicePorts"]/listitem[variable[@name="Service"]="SMTP"]').Count -ne 1){throw 'SMTP lost'}
  $https=@($xml.SelectNodes('/config/list[@name="ServicePorts"]/listitem[variable[@name="Service"]="HTTPS"]')|ForEach-Object OuterXml)
  if((Listener-Key $https) -ne '0.0.0.0:443'){throw 'HTTPS not restored'}
  if($xml.SelectSingleNode('/config/table[@name="Http"]/variable[@name="UseProxiedInfo"]').InnerText -ne '0'){throw 'Proxy flag not restored'}
  if($xml.SelectNodes('/config/list[@name="IpAccessList"]/listitem').Count -ne 1){throw 'IP group restoration failed'}
  if($xml.SelectSingleNode('/config/list[@name="IpAccessList"]/listitem/variable').InnerText -ne 'theirs'){throw 'Unrelated IP group removed'}
  Write-Output 'PASS: rollback preserves unrelated Kerio settings and restores HTTPS/proxy configuration.'
} finally {
  # Both paths are created in this invocation and checked against the fixed temp prefix.
  $resolved=[IO.Path]::GetFullPath($dir)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('KerioSwitcher-config-test-')){
    foreach($file in $path,($path+'.kas-new'),($path+'.kas-previous')){if(Test-Path $file){Remove-Item -LiteralPath $file -Force}}
    [IO.Directory]::Delete($dir,$false)
  }
}
