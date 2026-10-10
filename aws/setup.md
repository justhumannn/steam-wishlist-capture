# AWS 최초 배포 기록

한 번만 하면 되는 작업이다. 이미 끝나 있으므로, 평소 배포는 프로젝트 루트에서
`.\deploy.ps1` 만 실행하면 된다.

- 계정: `517723528459`
- 리전: `ap-northeast-2` (서울)
- 함수: `steam-wishlist` (nodejs22.x, arm64, 메모리 512MB, 제한시간 30초)
- 공개 주소: <https://wjwaphjx5mv6eqmj4y6cdp6jgy0xikls.lambda-url.ap-northeast-2.on.aws/>

## 1. 실행 역할

```powershell
aws iam create-role --role-name wishlist-lambda-role `
  --assume-role-policy-document file://aws/trust-policy.json `
  --description "Execution role for steam-wishlist-capture Lambda"

aws iam attach-role-policy --role-name wishlist-lambda-role `
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

> 역할 `--description`에는 한글을 못 쓴다. IAM이 ASCII/Latin-1만 받는다.

## 2. 함수 생성

```powershell
.\build.ps1

aws lambda create-function `
  --function-name steam-wishlist `
  --runtime nodejs22.x --architectures arm64 `
  --role arn:aws:iam::517723528459:role/wishlist-lambda-role `
  --handler lambda.handler --zip-file fileb://function.zip `
  --timeout 30 --memory-size 512
```

## 3. 공개 URL

```powershell
aws lambda create-function-url-config --function-name steam-wishlist --auth-type NONE

aws lambda add-permission --function-name steam-wishlist `
  --statement-id PublicFunctionUrl --action lambda:InvokeFunctionUrl `
  --principal "*" --function-url-auth-type NONE

# 아래가 없으면 위까지 다 해도 403이 난다 (사연은 '함정' 참고)
aws lambda add-permission --function-name steam-wishlist `
  --statement-id AllowPublicInvoke --action lambda:InvokeFunction `
  --principal "*"
```

---

# 겪은 함정들

## 함정 1 — Compress-Archive로 zip을 만들면 안 된다

PowerShell의 `Compress-Archive`는 경로를 `public\app.js`처럼 역슬래시로 저장한다.
리눅스인 Lambda는 이걸 폴더로 보지 않고 `public\app.js`라는 이름의 파일 하나로 읽어서,
정적 파일이 전부 404가 된다.

Windows에 기본으로 들어 있는 `tar.exe`(bsdtar)를 쓰면 `public/app.js`로 올바르게 들어간다.
`build.ps1`이 이걸 쓰고, zip 안에 역슬래시가 있으면 빌드를 실패시킨다.

## 함정 2 — 함수 URL이 403을 뱉는다

2024년 이후에 만든 AWS 계정은 **Lambda 함수 URL 퍼블릭 액세스 차단**이 기본으로 켜져 있다.
`--auth-type NONE`으로 만들고 `lambda:InvokeFunctionUrl` 권한까지 줘도
`AccessDeniedException`이 나면서 함수는 실행조차 되지 않는다(로그도 안 남는다).

조건 없는 `lambda:InvokeFunction` 권한을 하나 더 주면 통과한다.

## 함정 3 — 동시 실행 한도가 10이라 이미지가 깨졌다

신규 계정의 Lambda 동시 실행 한도는 **10**이다(기본 1000이 아니다).
찜한 게임이 40개면 브라우저가 이미지 40장을 한꺼번에 요청하는데,
함수 URL은 HTTP/2라 브라우저가 요청 수를 알아서 줄여주지도 않는다.

측정해 보니 39개 중 **8개만 200, 29개가 429, 2개가 502**였다.

`public/app.js`에서 이미지 요청을 한 번에 4개로 제한하고 실패 시 재시도하도록 고쳤다.
목록 썸네일도 같은 대기열을 쓰게 해서 요청이 두 배로 늘지 않게 했다.
고친 뒤에는 40개 요청 전부 성공한다.

동시 실행 한도는 Service Quotas에서 올릴 수 있지만, 지금 트래픽에는 필요 없다.

## 함정 4 — `--query`에 한글을 쓰면 깨진다

Windows PowerShell 콘솔 인코딩 때문에 `--query '{이름:FunctionName}'` 같은 건
JMESPath 파싱 오류가 난다. `--query`에는 영문만 쓴다.

같은 이유로 `.ps1` 파일은 **UTF-8 BOM**으로 저장해야 한다.
BOM이 없으면 PowerShell 5.1이 ANSI로 읽어서 스크립트 안의 한글이 깨진다.

---

# 비용

Lambda의 월 100만 요청 / 400,000 GB-초는 12개월 한정이 아니라 **항상 무료**다.
측정된 실행 시간은 요청당 36~133ms, 메모리 사용량은 512MB 중 119MB였다.

요청당 약 0.025 GB-초이므로 GB-초 한도로는 1,600만 요청까지 가능하고,
**요청 수(100만)가 먼저 걸린다.** 페이지 한 번 열 때 이미지까지 약 45요청이므로
월 2만 회 정도 열어도 무료 범위 안이다.

단, Free Plan 계정은 가입 6개월 뒤 또는 크레딧 소진 시 **계정이 닫힌다.**
계속 서비스하려면 그 전에 Paid Plan으로 전환해야 하고, 위 사용량이면 전환해도 실질 $0이다.

---

# 도메인 연결 (wishlist.quest)

```
사용자 → wishlist.quest → CloudFront → Lambda 함수 URL
```

- 도메인: `wishlist.quest` (hosting.kr 구매, DNS도 hosting.kr에서 관리 → Route 53 비용 0원)
- 인증서: `arn:aws:acm:us-east-1:517723528459:certificate/2410fa1b-360b-4c85-8036-5fc857d48ca0`
- CloudFront 배포판: `E2S5EAK43BHGZB` (`d1a1xaw50wrvm9.cloudfront.net`)
- 캐시 정책: `03d1611a-6eb9-437b-9d19-bd3e31fc57e0`

## hosting.kr DNS 레코드

| 유형 | 호스트 이름 | 값 |
| --- | --- | --- |
| CNAME | `@` | `d1a1xaw50wrvm9.cloudfront.net` |
| CNAME | `www` | `d1a1xaw50wrvm9.cloudfront.net` |
| CNAME | `_2eb687e7cf18c5673dec6f4c2df97752` | `_d40ec516076e4639020386cd34bf11fc.jkddzztszm.acm-validations.aws.` |
| CNAME | `_e603b90880c37237778e98dac84a01e4.www` | `_9892caf634aa3f5b9a928a368bd9e625.jkddzztszm.acm-validations.aws.` |

아래 두 개는 인증서 검증용이다. **지우면 안 된다.** 인증서 자동 갱신에 계속 쓰인다.

## 함정 5 — 인증서는 반드시 us-east-1

CloudFront에 붙일 ACM 인증서는 배포판이 어느 리전을 보든 상관없이
**`us-east-1`에서 발급**해야 한다. 서울(ap-northeast-2)에서 발급하면 목록에 뜨지도 않는다.

## 함정 6 — Host 헤더를 원본에 넘기면 안 된다

Lambda 함수 URL은 자기 호스트명(`wjwaphjx5....lambda-url...`)으로 라우팅한다.
CloudFront가 `Host: wishlist.quest`를 그대로 전달하면 원본이 요청을 인식하지 못한다.

그래서 오리진 요청 정책을 **`Managed-AllViewerExceptHostHeader`**
(`b689b0a8-53d0-40ab-baf2-68738e2966ac`)로 지정했다.
쿼리스트링은 전부 전달하면서 Host만 빼준다.

## 함정 7 — 기본 캐시 정책은 쿼리스트링을 버린다

관리형 `CachingOptimized`는 쿼리스트링을 캐시 키에 넣지도, 원본에 넘기지도 않는다.
이 앱은 `/api/wishlist?url=...`과 `/api/image?u=...`가 전부 쿼리스트링이라 그대로 쓰면 망가진다.

그래서 쿼리스트링을 전부 포함하는 정책을 따로 만들었다(`aws/cache-policy.json`).
TTL은 Default 0 / Min 0으로 두어, **원본이 보낸 `Cache-Control`이 캐시 기간을 결정**하게 했다.
이미지는 24시간, 정적 파일은 5분, `/api/wishlist`는 헤더가 없으므로 캐시되지 않는다.

## 루트 도메인(@) CNAME 문제

CNAME은 원래 루트 도메인에 못 붙는다(DNS 표준). hosting.kr 문서상으로는
클라우드 네임서버(`ns1/ns2.hostingkr.net`)로 바꿔야 `CNAME(Alias)` 유형을 쓸 수 있다고 되어 있다.

그런데 실제로는 **기본 IDC 네임서버(`ns1~4.hosting.co.kr`)에서도 `@` CNAME이 동작한다.**
등록해 두면 조회 시 CloudFront IP가 A 레코드로 응답된다(CNAME 평탄화).
네임서버를 바꿀 필요가 없었다.

## 비용

CloudFront는 월 1TB 전송 / 1천만 요청까지 항상 무료, ACM 인증서도 무료다.
DNS를 hosting.kr에서 관리하므로 Route 53 호스팅 영역 비용($0.50/월)도 들지 않는다.
**추가 비용은 도메인 값뿐이다.**

## 함정 8 — 배포해도 예전 화면이 보인다

CloudFront와 브라우저가 예전 `app.js` / `style.css`를 들고 있어서, 코드를 고치고
올려도 화면이 그대로인 경우가 있다. 두 겹으로 막았다.

- `index.html`은 `Cache-Control: no-cache`로 내려보내 매번 새로 확인하게 한다.
- `index.html` 안에서 CSS/JS를 `?v=2`처럼 버전을 붙여 부른다.
  **CSS나 JS를 고치면 이 숫자를 올려야 한다.**
- `deploy.ps1`이 CloudFront 캐시 무효화(`/*`)까지 자동으로 하고 완료를 기다린다.

무효화는 월 1,000개 경로까지 무료다.

---

# 찜 목록 링크의 필터

`?min_discount=any&type_filters=games` 처럼 필터가 걸린 링크를 넣으면
스팀 페이지와 같은 결과만 골라낸다.

## 왜 페이지를 긁어오지 않는가

"링크에 들어갔을 때 보이는 것만 가져오기"가 가장 정확할 것 같지만 안 된다. 실제로 재보니:

- 스팀 찜 목록 페이지는 서버 렌더링이 맞지만, **HTML에는 앞쪽 16개 정도만** 들어 있다.
  (39개짜리 목록으로 확인: HTTP 200, 정상 페이지, 그런데 appid는 16개뿐)
  나머지는 스크롤할 때 브라우저가 더 불러온다.
- 페이지 요청은 **금방 429로 막힌다.** 몇 번만 연달아 부르면 "찜 목록 - 오류"가 돌아온다.
  공개 사이트가 사용자마다 이 요청을 보내면 곧바로 차단당한다.
- 클래스 이름이 `_9KYdPze1X3k-` 처럼 난독화되어 있어 스팀이 배포할 때마다 깨진다.

그래서 링크에 붙은 필터 조건을 읽어 **같은 기준으로 우리가 직접 거른다.**

## 확인한 값들

`min_discount=any` 는 "할인 중인 것만"이다. 39개 중 3개(Öoo 30%, Servant of the Lake 25%,
STEINS;GATE RE:BOOT 10%)만 남으며, 스팀 페이지 결과와 정확히 일치한다.

`type` 값은 실제 항목으로 확인했다:

| type | 뜻 | 확인에 쓴 항목 |
| --- | --- | --- |
| 0 | 게임 | Counter-Strike 2 |
| 4 | DLC | Cities: Skylines - After Dark |
| 6 | 소프트웨어 | Wallpaper Engine |
| 11 | 사운드트랙 | Terraria: Official Soundtrack |

지원하는 필터: `min_discount`, `type_filters`, `os_filters`, `search`/`q`.
`tag_filters`, `price_filters`, `hide_owned` 등은 아직 못 다루며,
**조용히 무시하지 않고 화면에 "지원하지 않는 필터"라고 알린다.**

모르는 종류 이름이 섞여 있으면 잘못 걸러내느니 `type_filters` 전체를 건너뛴다.

---

# 게임이 아주 많을 때 (1,600개)

## 함정 9 — 캔버스는 무한정 커지지 않는다

크롬은 캔버스 한 변 **65,535px**, 전체 넓이 **약 2억 6천만 px**가 한계다.
1,600개를 가로 3개로 한 장에 담으면 높이가 **188,624px**이 되어 한계의 3배다.
저장 버튼을 눌러도 아무 일도 일어나지 않는다.

한 변 30,000px / 넓이 1억 1천만 px를 안전선으로 잡고, 넘치면 여러 장으로 나눈다.
1,600개는 7장(장당 249개)이 되고 한 장이 2,008×29,872px로 1.3초 만에 저장된다.
`한 장에 담을 게임 수` 옵션으로 더 잘게 나눌 수도 있다.

## 이미지 메모리와 대기 시간

1,600장을 전부 붙들고 있으면 수백 MB가 된다. 이미지 캐시를 **최근 160장**으로 제한하고,
전부 받아놓고 그리는 대신 **8장씩 앞서 받으면서 받는 대로 그린다.**
또 미리보기는 **현재 장만** 그리므로 1,600개여도 처음 기다림이 249개분으로 끝난다.

목록 썸네일은 접힌 `<details>` 안에 lazy로 두어, 펼치기 전에는 요청이 나가지 않는다.

## 스팀 조회도 나눠서

게임 정보는 50개씩 묶어 조회하는데 1,600개면 묶음이 32개다.
전부 동시에 던지면 스팀이 거절하므로 **한 번에 6묶음씩**만 굴린다.

## 여러 장일 때의 규칙

- **상단 정보(프로필·통계·`WISHLIST` 제목·푸터)는 첫 장에만** 넣는다.
  둘째 장부터는 카드만 이어진다. 첫 장이 그만큼 더 길다.
- 장마다 담는 개수는 **첫 장 기준으로 통일**한다. 첫 장이 상단 정보 때문에 가장 빡빡하므로
  그 기준을 쓰면 모든 장이 한계 안에 들어온다. 뒷장은 상단 정보가 없어 높이만 조금 짧아진다.
- 저장하면 **zip 하나로 묶여** 한 번에 받아진다. 파일을 하나씩 내려주면 브라우저가
  "여러 파일 다운로드" 허용을 묻고 사용자도 번거롭기 때문이다.

## zip은 직접 만든다

의존성을 0개로 유지하려고 `public/app.js` 안에 최소한의 zip 작성기를 넣었다.

- JPG/PNG는 이미 압축되어 있으므로 **압축 없이(store, method 0)** 담는다. deflate가 필요 없다.
- 한글 파일명 때문에 general purpose flag의 **비트 11(UTF-8)** 을 세운다. 안 세우면
  압축 해제 시 이름이 깨진다.
- CRC32는 직접 계산한다. **CRC를 구하는 동안만 바이트를 펼치고 담아둘 때는 Blob만 들고 있어야**
  메모리가 두 배로 뛰지 않는다.
- 검증: 3장짜리 zip을 만들어 Windows 기본 압축 해제로 풀었을 때 CRC 통과, 한글 파일명 유지,
  각 파일이 정상 JPEG임을 확인했다.

---

# 사용량 확인하기

## 대시보드 (제일 편함)

CloudWatch에 `wishlist-quest` 대시보드를 만들어 두었다. 요청 수, 오류, 응답 시간,
전송량이 한 화면에 나온다.

<https://ap-northeast-2.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-2#dashboards/dashboard/wishlist-quest>

대시보드는 계정당 3개까지 무료다.

고치려면 `aws/dashboard.json`을 수정하고:

```powershell
$env:AWS_CLI_FILE_ENCODING = 'UTF-8'
aws cloudwatch put-dashboard --dashboard-name wishlist-quest `
  --dashboard-body file://aws/dashboard.json --region ap-northeast-2
```

> `AWS_CLI_FILE_ENCODING=UTF-8`을 빼면 한글이 든 파일을 CLI가 못 읽는다.
> (`text contents could not be decoded` 오류)

## 콘솔에서 직접 볼 때

| 보고 싶은 것 | 위치 | 리전 |
| --- | --- | --- |
| Lambda 호출 수·오류·응답 시간 | Lambda → 함수 → `steam-wishlist` → **모니터링** 탭 | 서울 |
| 실제 방문자 요청 | CloudFront → 배포 → `E2S5EAK43BHGZB` → **모니터링** 탭 | 버지니아 북부 |
| 남은 크레딧 | 계정 메뉴 → 결제 및 비용 관리 → **크레딧** | — |

**리전을 잘못 고르면 그래프가 비어 보인다.** Lambda 지표는 서울(ap-northeast-2)에,
CloudFront 지표는 버지니아 북부(us-east-1)에만 있다.

## 두 숫자의 차이

CloudFront 요청이 Lambda 호출보다 많은 것이 정상이다. **그 차이가 캐시가 아껴준 양**이다.
이미지는 24시간 캐시되므로, 같은 찜 목록을 다시 열면 Lambda까지 내려오지 않는다.

## 터미널에서

```powershell
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Invocations `
  --dimensions Name=FunctionName,Value=steam-wishlist `
  --start-time 2026-08-14T00:00:00Z --end-time 2026-08-21T00:00:00Z `
  --period 86400 --statistics Sum --region ap-northeast-2 --output table
```

> `--query`에는 한글을 쓰지 말 것 (함정 4 참고).

## 프리 티어 메뉴는 비어 있다

`aws freetier get-free-tier-usage`가 빈 결과를 돌려준다. Free Plan 계정은 프리 티어 추적 대신
크레딧으로 관리되기 때문으로 보인다. 사용량은 위 대시보드로, 잔액은 크레딧 화면에서 본다.

---

# 라이브러리(보유 게임) 기능

찜 목록과 달리 **스팀 웹 API 키가 반드시 필요하다.** 2026년 10월 기준으로
키 없이 보유 게임을 가져올 방법이 전부 막혀 있음을 직접 확인했다:

| 시도한 방법 | 결과 |
| --- | --- |
| `steamcommunity.com/profiles/<id>/games?tab=all&xml=1` | **302** 로그인 리디렉션 |
| 게임 목록 페이지 HTML | **Sign In** 페이지 |
| `IPlayerService/GetOwnedGames` (키 없이) | **401** Unauthorized |

프로필이 `public`(visibilityState 3)인데도 302가 났다. 즉 프로필 공개 여부와 무관하게
커뮤니티 게임 목록이 익명 접근을 막는다.

## 키 설정

키는 <https://steamcommunity.com/dev/apikey> 에서 무료로 발급한다.
**저장소에는 절대 넣지 않는다.** Lambda 환경 변수로만 둔다.

```powershell
aws lambda update-function-configuration --function-name steam-wishlist `
  --environment "Variables={STEAM_API_KEY=발급받은키}" --region ap-northeast-2
```

> `--environment`는 기존 환경 변수를 **통째로 교체**한다. 나중에 다른 변수를 추가할 때는
> 기존 것까지 같이 적어야 한다.

`deploy.ps1`은 `update-function-code`만 호출하므로 **재배포해도 키는 지워지지 않는다.**

키가 없으면 `/api/library`가 503과 함께 "준비 중" 안내를 돌려주고, 찜 목록 기능은
키와 무관하게 그대로 동작한다.

## 함정 10 — 공개 프로필에 없는 게임이 딸려온다

처음에 `include_played_free_games=1`로 불렀더니 숨긴 게임이 나온다는 제보를 받았다. 재보니:

| | 개수 |
| --- | --- |
| `include_played_free_games=1` | 80 |
| `include_played_free_games=0` | 61 |
| **공개 프로필 페이지 표시** | **60** |

차이 19개는 전부 **플레이만 한 무료 게임**(VRChat, Goose Goose Duck, Poppy Playtime 등)이었다.
공개 프로필은 이걸 세지 않는다. 남이 보는 화면과 맞추는 것이 맞으므로 껐다.

응답 어디에도 숨김 여부를 나타내는 필드는 없다. `include_extended_appinfo=true`로
필드를 15개까지 늘려봐도 (capsule_filename, has_workshop, has_market, has_dlc가 추가될 뿐)
숨김 플래그는 없다. `skip_unvetted_apps=false`로 하면 94개가 되는데 이건 미심사 앱 얘기로 숨김과 무관하다.

**주의: API 키 주인이 자기 프로필을 조회하면 프라이버시가 일부 우회된다.**
무료 게임을 뺀 61개와 공개 프로필의 60개가 1개 차이나는 것이 그 흔적으로 보인다.
남의 프로필을 조회할 때는 스팀이 정상적으로 걸러준다.

게임 세부 정보가 비공개면 빈 응답이 와서 404와 안내 문구를 띄운다.

## 한글 조사

상태 문구를 "찜 목록을 / 라이브러리를"처럼 바꾸려고 받침 유무를 계산한다.
`(글자코드 - 0xAC00) % 28 !== 0` 이면 받침이 있다. "을(를)"로 적으면 보기 싫다.

## 화면 차이

같은 카드 UI를 쓰되 모드에 따라 문구와 기준이 바뀐다.

| | 찜 목록 | 라이브러리 |
| --- | --- | --- |
| 카드 윗줄 | 찜한 날짜 | 플레이 시간 |
| 카드 아래 띠 | 출시일 | 마지막 플레이 |
| 배지 | 출시 예정 | 미플레이 |
| 통계 4칸 | 찜한 게임 / 가장 오래된 찜 / 가장 최근 찜 / 출시 예정 | 보유 게임 / 총 플레이 시간 / 가장 많이 한 게임 / 안 해본 게임 |
| 정렬 | 찜한 날짜, 우선순위, 이름 | 플레이 시간, 최근 플레이, 이름 |
| 섹션 제목 | `WISHLIST` | `LIBRARY` |

모드를 바꾸면 이전 모드로 불러온 목록은 지운다. 섞이면 엉뚱한 정보가 표시되기 때문이다.
