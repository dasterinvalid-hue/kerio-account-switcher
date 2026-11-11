#requires -Version 5.1
param([string]$InstallDir=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
try {
  $state=Get-Content -LiteralPath (Join-Path $InstallDir 'install-state.json') -Raw | ConvertFrom-Json
  if($state.status -notin @('installed','preparing')){throw 'Inactive installation'}
  # Only this short SYSTEM task reads Kerio configuration/keys. The HTTP service
  # stays under its restricted virtual account and reads only its TLS snapshot.
  $settings=[Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver=$null
  $reader=[Xml.XmlReader]::Create((Join-Path $state.kerioPath 'mailserver.cfg'),$settings)
  try{$xml=[xml]::new();$xml.XmlResolver=$null;$xml.Load($reader)}finally{$reader.Dispose()}
  $name=$xml.SelectSingleNode('/config/table[@name="Misc"]/variable[@name="SslCertificate"]').InnerText
  if($name -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'){throw 'Invalid certificate name'}
  $node=Join-Path $InstallDir 'runtime\node.exe'
  $result=@(& $node (Join-Path $InstallDir 'windows\publish-certificate.mjs') $InstallDir $state.kerioPath $name 2>&1)
  if($LASTEXITCODE -ne 0){throw 'Certificate verification failed'}
  if($result.Count){Write-Output ($result -join [Environment]::NewLine)}
  exit 0
} catch {
  # No raw XML/PEM/OpenSSL error text in task history or public diagnostics.
  Write-Output 'TLS sync failed; last working snapshot retained. Check Kerio active certificate, key and validity.'
  exit 1
}
