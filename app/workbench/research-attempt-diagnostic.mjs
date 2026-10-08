// Only known adapter diagnostics reach the UI. Stored attempt errors can contain
// untrusted upstream text, so never display an unmatched value directly.
const FIXED_DIAGNOSTICS = new Map([
  ['Doubao web search requires DOUBAO_SEARCH_API_KEY', '执行机缺少豆包搜索 Key'],
  ['DOUBAO_SEARCH_API_KEY is invalid', '执行机豆包搜索 Key 格式无效'],
  ['Doubao web search request timed out', '请求超时'],
  ['Doubao web search request timed out while reading response body', '读取响应超时'],
  ['Doubao web search network request failed', '网络请求失败'],
  ['Doubao web search returned an empty response body', '接口响应为空'],
  ['Doubao web search response is too large', '接口响应过大'],
  ['Doubao web search response body transfer was interrupted', '响应传输中断'],
  ['Doubao web search response is not valid JSON', '接口响应格式无效'],
  ['Doubao web search failed with an invalid service response', '接口响应格式无效（旧记录）'],
  ['Doubao web search failed with invalid ErrorCode', '接口 ErrorCode 无效'],
  ['Doubao web search failed with an API error without safe code', '接口错误，未返回安全错误码'],
  ['Doubao web search failed with missing Result', '接口响应缺少 Result'],
  ['Doubao web search failed with missing ErrorCode', '接口响应缺少 ErrorCode'],
  ['Doubao web search returned no source evidence', '接口未返回可用来源'],
  ['web search returned no public sources', '未取得公开网页来源'],
  ['web search returned no authoritative evidence', '未取得权威来源'],
  ['web search returned no authoritative or grounded evidence', '来源证据不足'],
  ['web search total time budget exhausted', '搜索总时限已用尽'],
  ['web search attempt timed out', '单次搜索超时'],
  ['web search provider mismatch', '搜索服务返回标识不一致'],
  ['web search provider is not configured', '执行机未配置该搜索服务'],
]);

const KNOWN_API_CODES = new Set([
  'AccessDenied', 'AuthenticationFailed', 'Forbidden', 'InternalError',
  'InvalidAccessKey', 'InvalidParameter', 'InvalidToken', 'LimitExceeded',
  'NoPermission', 'PermissionDenied', 'QuotaExceeded', 'RateLimitExceeded',
  'ServiceUnavailable', 'SignatureDoesNotMatch', 'TooManyRequests', 'Unauthorized',
]);

export function safeDoubaoSearchDiagnostic(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const fixed = FIXED_DIAGNOSTICS.get(value);
  if (fixed) return fixed;

  const http = /^Doubao web search failed with HTTP ([45][0-9]{2})$/u.exec(value);
  if (http) return `HTTP ${http[1]}`;

  const service = /^Doubao web search failed with service code ([1-9][0-9]{0,6})$/u.exec(value);
  if (service) return `服务错误码 ${service[1]}`;

  const numericApi = /^Doubao web search failed with API code ([1-9][0-9]{0,6})$/u.exec(value);
  if (numericApi) return `API 错误码 ${numericApi[1]}`;

  const api = /^Doubao web search failed with API code ([A-Za-z][A-Za-z0-9._-]{0,31})$/u.exec(value);
  if (api && KNOWN_API_CODES.has(api[1])) return `API 错误码 ${api[1]}`;
  if (value.startsWith('Doubao web search failed with API code ')) return 'API 错误码已隐藏';
  return null;
}
