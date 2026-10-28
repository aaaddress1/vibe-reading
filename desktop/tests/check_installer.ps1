param([Parameter(Mandatory=$true)][string]$MsiPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$installFolder = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\VibeReading'
$expectedRoot = [IO.Path]::GetFullPath($installFolder)
$manifest = Get-Content -LiteralPath (Join-Path $root 'build\installer\payload.json') -Raw | ConvertFrom-Json
$installer = New-Object -ComObject WindowsInstaller.Installer
$logs = Join-Path $root 'preview'
function Get-ProductCode {
    $database = $installer.OpenDatabase($MsiPath, 0)
    $query = $database.OpenView('SELECT `Value` FROM `Property` WHERE `Property` = ''ProductCode''')
    $query.Execute()
    $row = $query.Fetch()
    $code = $row.StringData(1)
    $query.Close()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($row)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($query)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    return $code
}
function Invoke-Msi([string[]]$Action, [string]$Stage) {
    Write-Output "Checking MSI stage: $Stage"
    $log = Join-Path $logs ('msi-' + $Stage + '.log')
    $arguments = $Action + @('/qn', '/norestart', '/l*v', ('"' + $log + '"'))
    $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -notin @(0, 3010)) { throw "MSI $Stage failed: $($process.ExitCode); see $log" }
}
function Get-ProductRegistryPath([string]$ProductCode) {
    $digits = $ProductCode.Replace('{', '').Replace('}', '').Replace('-', '')
    $packed = -join (($digits.Substring(0,8).ToCharArray())[7..0])
    $packed += -join (($digits.Substring(8,4).ToCharArray())[3..0])
    $packed += -join (($digits.Substring(12,4).ToCharArray())[3..0])
    for ($i = 16; $i -lt 32; $i += 2) { $packed += $digits[$i+1]; $packed += $digits[$i] }
    return 'HKCU:\Software\Microsoft\Installer\Products\' + $packed
}
function Assert-Payload {
    foreach ($entry in $manifest.PSObject.Properties) {
        $target = Join-Path $installFolder $entry.Name
        if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.Value) {
            throw "Missing or altered installed payload: $($entry.Name)"
        }
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcut in @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Vibe Reading.lnk'),
                            (Join-Path ([Environment]::GetFolderPath('Programs')) 'Vibe Reading\Vibe Reading.lnk'))) {
        if (!(Test-Path -LiteralPath $shortcut)) { throw "Missing shortcut: $shortcut" }
        if ($shell.CreateShortcut($shortcut).TargetPath -ne (Join-Path $installFolder 'VibeReading.exe')) { throw "Incorrect shortcut: $shortcut" }
    }
}
$modelFile = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'VibeReading\models') -Filter tokenizer.json -File -Recurse | Select-Object -First 1
$modelHash = (Get-FileHash -LiteralPath $modelFile.FullName).Hash
$oldProduct = Get-ProductCode
Invoke-Msi @('/i', ('"' + $MsiPath + '"')) 'fresh-install'
Assert-Payload
$env:VIBE_DESKTOP_OFFLINE = '1'
$smoke = Join-Path $root 'preview\installed'
$smokeProcess = Start-Process -FilePath (Join-Path $installFolder 'VibeReading.exe') -ArgumentList @('--no-hook', '--smoke-test', ('"' + $smoke + '"'), '--smoke-profile', 'nllb-600m') -Wait -PassThru -WindowStyle Hidden
if ($smokeProcess.ExitCode -ne 0) { throw 'Installed executable failed offline translation' }
$measurements = Get-Content -LiteralPath (Join-Path $smoke 'measurements.json') -Raw | ConvertFrom-Json
if (!$measurements.translation -or !$measurements.modelLoadedBeforeFirstTranslation) { throw 'Installed model did not load and translate' }
$repairTarget = [IO.Path]::GetFullPath((Join-Path $installFolder 'vibe_desktop\assets\icon.png'))
if (!$repairTarget.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Repair target escaped installation directory' }
Remove-Item -LiteralPath $repairTarget
Invoke-Msi @('/fa', $oldProduct) 'repair'
Assert-Payload
& python (Join-Path $root 'build_installer.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not create replacement MSI for upgrade test' }
$newProduct = Get-ProductCode
if ($oldProduct -eq $newProduct) { throw 'Replacement build reused product code' }
Invoke-Msi @('/i', ('"' + $MsiPath + '"')) 'upgrade'
Assert-Payload
$oldKey = (Get-ProductRegistryPath $oldProduct).Replace('HKCU:', 'HKCU')
$newKey = (Get-ProductRegistryPath $newProduct).Replace('HKCU:', 'HKCU')
# Read registration in fresh native processes after the MSI transaction.
& "$env:SystemRoot\System32\reg.exe" query $oldKey 2>$null | Out-Null
$oldStillInstalled = $LASTEXITCODE -eq 0
& "$env:SystemRoot\System32\reg.exe" query $newKey 2>$null | Out-Null
if ($oldStillInstalled -or $LASTEXITCODE -ne 0) { throw "Upgrade registration check failed: $oldProduct -> $newProduct" }
Invoke-Msi @('/x', $newProduct) 'uninstall'
if (Test-Path -LiteralPath (Join-Path $installFolder 'VibeReading.exe')) { throw 'Uninstall left executable behind' }
if (!(Test-Path -LiteralPath $modelFile.FullName) -or (Get-FileHash -LiteralPath $modelFile.FullName).Hash -ne $modelHash) { throw 'Uninstall changed model cache' }
Invoke-Msi @('/i', ('"' + $MsiPath + '"')) 'final-install'
Assert-Payload
@{freshInstall=$true; repairedMissingFile=$true; replacementUpgrade=$true; uninstall=$true; modelCachePreserved=$true;
  desktopAndStartMenuShortcuts=$true; installedOfflineTranslation=$true; finalInstalled=$true;
  installedPath=$installFolder; productCode=$newProduct} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'installer-validation.json') -Encoding utf8
Write-Output 'MSI: install, repair, replacement upgrade, uninstall, cache preservation, shortcuts and installed offline translation passed.'
