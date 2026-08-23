# Lambda에 올릴 배포 zip을 만든다.
#
# 주의: PowerShell의 Compress-Archive는 쓰지 않는다. 경로를 'public\app.js'처럼
# 역슬래시로 저장해서, 리눅스인 Lambda가 public 폴더를 인식하지 못한다.
# Windows에 기본으로 들어 있는 tar.exe(bsdtar)는 'public/app.js'로 올바르게 저장한다.

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$zip  = Join-Path $root 'function.zip'

if (Test-Path $zip) { Remove-Item $zip -Force }

Push-Location $root
try {
    & "$env:SystemRoot\System32\tar.exe" -a -c -f $zip lambda.js router.js public
    if ($LASTEXITCODE -ne 0) { throw "zip 생성 실패 (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

# 리눅스에서 읽을 수 있는 경로로 들어갔는지 확인한다.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $bad = $archive.Entries | Where-Object { $_.FullName -like '*\*' }
    if ($bad) { throw "zip 안의 경로에 역슬래시가 있습니다: $($bad.FullName -join ', ')" }

    Write-Host ""
    Write-Host "function.zip 생성 완료" -ForegroundColor Green
    $archive.Entries | ForEach-Object { Write-Host ("  " + $_.FullName) }
}
finally {
    $archive.Dispose()
}

Write-Host ("  크기: " + [math]::Round((Get-Item $zip).Length / 1KB, 1) + " KB")
Write-Host ""
