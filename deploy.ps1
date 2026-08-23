# 코드를 고친 뒤 AWS Lambda에 다시 올린다.
#   .\deploy.ps1
#
# 처음 한 번은 aws\setup.md에 적힌 대로 함수와 역할을 만들어 둬야 한다.

$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''

$FunctionName   = 'steam-wishlist'
$Region         = 'ap-northeast-2'
$DistributionId = 'E2S5EAK43BHGZB'
$SiteUrl        = 'https://wishlist.quest'

# AWS CLI가 PATH에 없을 수도 있어서(설치 직후 등) 직접 경로도 확인한다.
$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = 'C:\Users\yeocj\tools\awscli\Amazon\AWSCLIV2\aws.exe' }
if (-not (Test-Path $aws)) { throw 'AWS CLI를 찾을 수 없습니다.' }

$root = $PSScriptRoot
$zip  = Join-Path $root 'function.zip'

& (Join-Path $root 'build.ps1')

Write-Host "업로드 중..." -ForegroundColor Cyan
& $aws lambda update-function-code `
    --function-name $FunctionName `
    --region $Region `
    --zip-file "fileb://$zip" `
    --output text --query 'LastUpdateStatus' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "업로드 실패 (exit $LASTEXITCODE)" }

& $aws lambda wait function-updated-v2 --function-name $FunctionName --region $Region
if ($LASTEXITCODE -ne 0) { throw "배포 반영 대기 실패 (exit $LASTEXITCODE)" }

# CloudFront가 예전 파일을 들고 있으면 새 화면이 안 보인다. 캐시를 비운다.
Write-Host "CDN 캐시 비우는 중..." -ForegroundColor Cyan
$invalidationId = & $aws cloudfront create-invalidation --distribution-id $DistributionId `
    --paths "/*" --output text --query 'Invalidation.Id'
if ($LASTEXITCODE -ne 0) { throw "캐시 무효화 실패 (exit $LASTEXITCODE)" }
& $aws cloudfront wait invalidation-completed --distribution-id $DistributionId --id $invalidationId

# 실제로 살아 있는지 확인한다.
try {
    $health = Invoke-RestMethod -Uri "$SiteUrl/health" -TimeoutSec 30
    $ok = $health.ok
} catch {
    $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "배포 완료" -ForegroundColor Green
} else {
    Write-Host "배포는 됐지만 헬스체크에 실패했습니다. 로그를 확인하세요." -ForegroundColor Yellow
}
Write-Host "  $SiteUrl"
Write-Host ""
Write-Host "로그 보기:" -ForegroundColor DarkGray
Write-Host "  aws logs tail /aws/lambda/$FunctionName --follow --region $Region" -ForegroundColor DarkGray
Write-Host ""
