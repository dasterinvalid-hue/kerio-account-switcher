#requires -Version 5.1
param([string]$OutputDir=(Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'),[string]$WorkDir,[string]$NodePath)
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot -Parent
if(-not $WorkDir){$WorkDir=Join-Path ([IO.Path]::GetTempPath()) ('KerioSwitcher-build-'+[guid]::NewGuid().ToString('N'))}
if(Test-Path $WorkDir){throw 'WorkDir must be a new directory.'}
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir=[IO.Path]::GetFullPath($OutputDir)
$package=Join-Path $WorkDir 'package';New-Item -ItemType Directory -Path $package | Out-Null
$runtime=Join-Path $package 'runtime';New-Item -ItemType Directory -Path $runtime | Out-Null
$node=Join-Path $runtime 'node.exe'
$version='v24.22.0'
$nodeHash='ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c'
if($NodePath){Copy-Item -LiteralPath $NodePath -Destination $node}else{Invoke-WebRequest "https://nodejs.org/dist/$version/win-x64/node.exe" -OutFile $node -UseBasicParsing}
if((Get-FileHash $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeHash){throw 'Node.js SHA-256 mismatch'}
Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$version/LICENSE" -OutFile (Join-Path $runtime 'NODE-LICENSE.txt') -UseBasicParsing
foreach($name in 'server.mjs','core.mjs','package.json','config.example.json','README.md','LICENSE') {Copy-Item -LiteralPath (Join-Path $source $name) -Destination $package}
foreach($dir in 'public','windows','test'){Copy-Item -LiteralPath (Join-Path $source $dir) -Destination $package -Recurse}
& $node --test (Join-Path $package 'test\*.test.mjs');if($LASTEXITCODE -ne 0){throw 'JavaScript tests failed'}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'windows\Test-Config.ps1');if($LASTEXITCODE -ne 0){throw 'Configuration tests failed'}
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc=Join-Path $framework 'csc.exe'
& $csc /nologo /target:exe /platform:x64 /optimize+ ("/out:"+(Join-Path $package 'KerioAccountSwitcher.Service.exe')) /r:System.ServiceProcess.dll (Join-Path $source 'windows\ServiceHost.cs')
if($LASTEXITCODE -ne 0){throw 'Service host compilation failed'}
@{nodeVersion=$version;nodeSha256=$nodeHash;version='1.0.0'} | ConvertTo-Json | Set-Content (Join-Path $package 'build-info.json') -Encoding UTF8
$files=Get-ChildItem $package -Recurse -File | ForEach-Object {@{path=$_.FullName.Substring($package.Length+1).Replace('\','/');sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
$files | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $package 'package-manifest.json') -Encoding UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip=Join-Path $OutputDir 'KerioAccountSwitcher-1.0.0-windows-x64.zip'
if(Test-Path $zip){Remove-Item -LiteralPath $zip}
$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try{Get-ChildItem $package -Recurse -File | ForEach-Object {
  $entry=$_.FullName.Substring($package.Length+1).Replace('\','/')
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$_.FullName,$entry,[IO.Compression.CompressionLevel]::Optimal)
}}finally{$archive.Dispose()}
$exe=Join-Path $OutputDir 'KerioAccountSwitcher-Setup-1.0.0.exe'
& $csc /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ("/out:"+$exe) ("/win32manifest:"+(Join-Path $source 'windows\setup.manifest')) ("/resource:"+$zip+',payload.zip') /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll (Join-Path $source 'windows\Setup.cs')
if($LASTEXITCODE -ne 0){throw 'Setup compilation failed'}
# Inspect the embedded archive without executing the UAC-elevated installer.
$assembly=[Reflection.Assembly]::LoadFile($exe)
$stream=$assembly.GetManifestResourceStream('payload.zip')
$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read)
try{if(-not $archive.GetEntry('server.mjs') -or -not $archive.GetEntry('runtime/node.exe')){throw 'Setup payload verification failed'}}finally{$archive.Dispose();$stream.Dispose()}
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $OutputDir 'INSTRUCTION-RU.md') -Force
@($exe,$zip,(Join-Path $OutputDir 'INSTRUCTION-RU.md')) | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($_) } | Set-Content (Join-Path $OutputDir 'SHA256SUMS.txt') -Encoding ASCII
Write-Output "PACKAGE_ROOT=$package"
Write-Output "BUILD_OK=$OutputDir"
