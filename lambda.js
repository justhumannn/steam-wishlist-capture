'use strict';

/* AWS Lambda에서 실행할 때 쓰는 껍데기. 실제 처리는 router.js가 한다.
   함수 URL(Function URL)의 payload 형식 2.0 이벤트를 받는다. */

const { route } = require('./router');

exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
  const pathname = event.rawPath || '/';
  const query = new URLSearchParams(event.rawQueryString || '');

  const result = await route(method, pathname, query);

  // 본문을 항상 base64로 넘긴다. 이미지 같은 이진 데이터는 물론이고
  // 한글이 든 JSON/HTML도 인코딩이 깨지지 않는다.
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body.toString('base64'),
    isBase64Encoded: true,
  };
};
