const DEEPSEEK_RESPONSES_ENDPOINT = 'https://api.deepseek.com/responses';
export const DEEPSEEK_SIMULATION_MODEL = 'deepseek-v4-pro';

function requiredApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) throw new Error('DeepSeek simulation is not ready; set DEEPSEEK_API_KEY');
  if (apiKey.length > 2_000) throw new RangeError('DEEPSEEK_API_KEY is too long');
  return apiKey;
}

function validatedTimeout(value) {
  if (!Number.isInteger(value) || value < 5_000 || value > 300_000) {
    throw new RangeError('DeepSeek timeoutMs must be between 5000 and 300000');
  }
  return value;
}

function outputText(payload) {
  const parts = [];
  if (typeof payload?.output_text === 'string') parts.push(payload.output_text);
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue;
    if (typeof item.text === 'string') parts.push(item.text);
    if (typeof item.content === 'string') parts.push(item.content);
    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (typeof content?.text === 'string'
          && ['output_text', 'text'].includes(content.type ?? 'output_text')) {
          parts.push(content.text);
        }
      }
    }
  }
  const chatContent = payload?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') parts.push(chatContent);
  const text = parts.join('\n').trim();
  if (!text || text.length > 200_000) {
    throw new TypeError('DeepSeek Responses output is invalid');
  }
  return text;
}

function parsedJsonObject(rawText, label) {
  const normalized = String(rawText ?? '')
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const candidates = [normalized];
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Try a JSON object embedded in explanatory text or a Markdown fence.
    }
  }
  throw new TypeError(`${label} output is not a valid JSON object`);
}

function parsedSearchResult(rawText) {
  const normalized = rawText
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  let value;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new TypeError('DeepSeek web search output is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DeepSeek web search output must be an object');
  }
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!summary || !Array.isArray(value.sources) || value.sources.length < 1) {
    throw new TypeError('DeepSeek web search returned no grounded sources');
  }
  return { content: summary, sources: value.sources };
}

function cleanText(value, field, maximum) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || [...text].length > maximum) throw new TypeError(`${field} is invalid`);
  return text;
}

function remoteHttpUrl(value, field) {
  const text = cleanText(value, field, 8_192);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError(`${field} must be a credential-free HTTP(S) URL`);
  }
  return url.toString();
}

function parsedImageSearchResult(rawText, expectedPages) {
  const value = parsedJsonObject(rawText, 'DeepSeek image search');
  const nested = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data
    : {};
  let rawPages = value.pages ?? nested.pages;
  const flatImages = value.images ?? nested.images;
  if (!Array.isArray(rawPages) && Array.isArray(flatImages)) {
    const grouped = new Map();
    flatImages.forEach((image, index) => {
      const pageIndex = Number(image?.pageIndex ?? image?.page_index ?? image?.index ?? index + 1);
      const page = grouped.get(pageIndex) ?? {
        pageIndex,
        searchQuery: image?.searchQuery ?? image?.search_query ?? image?.query ?? image?.keyword,
        candidates: [],
      };
      page.candidates.push(image);
      grouped.set(pageIndex, page);
    });
    rawPages = [...grouped.values()].sort((left, right) => left.pageIndex - right.pageIndex);
  }
  if (!Array.isArray(rawPages) || rawPages.length !== expectedPages) {
    throw new TypeError('DeepSeek image search returned an invalid page list');
  }
  const seenUrls = new Set();
  const pages = rawPages.map((rawPage, index) => {
    const pageIndex = Number(rawPage?.pageIndex ?? rawPage?.page_index ?? rawPage?.index ?? index + 1);
    let rawCandidates = rawPage?.candidates ?? rawPage?.images ?? rawPage?.results;
    if (!Array.isArray(rawCandidates)
      && (rawPage?.imageUrl || rawPage?.image_url || rawPage?.url || rawPage?.src)) {
      rawCandidates = [rawPage];
    }
    if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)
      || pageIndex !== index + 1
      || !Array.isArray(rawCandidates)
      || rawCandidates.length < 1) {
      throw new TypeError(`DeepSeek image search page ${index + 1} is invalid`);
    }
    const candidates = [];
    for (const [candidateIndex, rawCandidate] of rawCandidates.entries()) {
      if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) continue;
      try {
        const imageUrl = remoteHttpUrl(
          rawCandidate.imageUrl ?? rawCandidate.image_url ?? rawCandidate.url ?? rawCandidate.src,
          `image search candidate ${index + 1}.${candidateIndex + 1}.imageUrl`,
        );
        if (seenUrls.has(imageUrl)) continue;
        const rawAttribution = rawCandidate.attribution
          ?? rawCandidate.author
          ?? rawCandidate.credit
          ?? rawCandidate.source;
        seenUrls.add(imageUrl);
        candidates.push({
          imageUrl,
          sourcePageUrl: remoteHttpUrl(
            rawCandidate.sourcePageUrl
              ?? rawCandidate.source_page_url
              ?? rawCandidate.sourceUrl
              ?? rawCandidate.source_url
              ?? rawCandidate.pageUrl
              ?? rawCandidate.page_url
              ?? imageUrl,
            `image search candidate ${index + 1}.${candidateIndex + 1}.sourcePageUrl`,
          ),
          title: cleanText(
            rawCandidate.title ?? rawCandidate.name ?? rawCandidate.caption ?? `第 ${index + 1} 页候选图片`,
            'image search candidate title',
            300,
          ),
          attribution: cleanText(
            typeof rawAttribution === 'string' ? rawAttribution : '来源页面',
            'image search candidate attribution',
            300,
          ),
          license: cleanText(
            rawCandidate.license ?? rawCandidate.licence ?? rawCandidate.usage ?? '待人工核验',
            'image search candidate license',
            160,
          ),
        });
      } catch {
        // One malformed model candidate must not invalidate the other candidates.
      }
    }
    if (candidates.length < 1) {
      throw new TypeError(`DeepSeek image search page ${index + 1} has no valid candidate`);
    }
    return {
      pageIndex: index + 1,
      searchQuery: cleanText(
        rawPage.searchQuery
          ?? rawPage.search_query
          ?? rawPage.query
          ?? rawPage.keyword
          ?? `第 ${index + 1} 页配图`,
        `image search page ${index + 1}.searchQuery`,
        300,
      ),
      candidates: candidates.slice(0, 4),
    };
  });
  return { pages };
}

function retryableImageSearchError(error) {
  const message = String(error?.message ?? '');
  const httpStatus = Number(message.match(/HTTP (\d{3})/u)?.[1]);
  if (Number.isInteger(httpStatus)) return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
  return error instanceof TypeError
    || /network request failed|did not complete/iu.test(message);
}

export function assertDeepSeekSimulationEnvironment(environment = process.env) {
  requiredApiKey(environment.DEEPSEEK_API_KEY);
}

export function createDeepSeekResponsesClient({
  apiKey = process.env.DEEPSEEK_API_KEY,
  fetchImpl = fetch,
  model = DEEPSEEK_SIMULATION_MODEL,
  maxOutputTokens = 16_384,
} = {}) {
  const secret = requiredApiKey(apiKey);
  if (model !== DEEPSEEK_SIMULATION_MODEL) {
    throw new TypeError(`DeepSeek simulation model must be ${DEEPSEEK_SIMULATION_MODEL}`);
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1_024 || maxOutputTokens > 32_768) {
    throw new RangeError('DeepSeek maxOutputTokens must be between 1024 and 32768');
  }

  async function createResponse({ prompt, timeoutMs = 180_000, webSearch = false }) {
    if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 30_000) {
      throw new RangeError('prompt must contain between 1 and 30000 characters');
    }
    let response;
    try {
      response = await fetchImpl(DEEPSEEK_RESPONSES_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(validatedTimeout(timeoutMs)),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model,
          input: prompt,
          max_output_tokens: webSearch ? Math.min(maxOutputTokens, 8_192) : maxOutputTokens,
          text: { format: { type: 'json_object' } },
          ...(webSearch ? {
            tools: [{ type: 'web_search' }],
            tool_choice: { type: 'web_search' },
          } : {}),
        }),
      });
    } catch {
      throw new Error('DeepSeek Responses network request failed');
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 502;
      throw new Error(`DeepSeek Responses failed with HTTP ${status}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TypeError('DeepSeek Responses response is not valid JSON');
    }
    if (payload?.status !== 'completed') {
      throw new Error(`DeepSeek Responses did not complete (${String(payload?.status ?? 'unknown')})`);
    }
    return { rawText: outputText(payload), model };
  }

  return {
    runText({ prompt, timeoutMs }) {
      return createResponse({ prompt, timeoutMs });
    },
    runReview({ prompt, timeoutMs }) {
      return createResponse({ prompt, timeoutMs });
    },
    async runWebSearch({ query, limit = 5, timeoutMs = 120_000 }) {
      const normalizedQuery = typeof query === 'string' ? query.trim() : '';
      if (normalizedQuery.length < 1 || normalizedQuery.length > 500) {
        throw new RangeError('web search query must contain between 1 and 500 characters');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new RangeError('web search limit must be an integer between 1 and 10');
      }
      const prompt = `请先使用联网搜索，再整理与下列选题直接相关的可靠资料。只返回合法 JSON，不要 Markdown。\n\n<untrusted_query>\n${JSON.stringify(normalizedQuery)}\n</untrusted_query>\n\n返回格式：{"summary":"基于搜索结果的资料摘要","sources":[{"title":"来源标题","url":"公开网页完整 URL","snippet":"支持摘要的原文要点","siteName":"网站名称"}]}。最多返回 ${limit} 个来源。每个来源必须确实来自本次联网搜索，不得编造 URL；优先政府、学校、标准组织、官方机构和权威媒体。`;
      const generated = await createResponse({ prompt, timeoutMs, webSearch: true });
      return {
        provider: 'deepseek',
        result: parsedSearchResult(generated.rawText),
      };
    },
    async runImageSearch({ query, copy, imagePlan, timeoutMs = 120_000 }) {
      const normalizedQuery = typeof query === 'string' ? query.trim() : '';
      if (normalizedQuery.length < 1 || normalizedQuery.length > 500) {
        throw new RangeError('image search query must contain between 1 and 500 characters');
      }
      if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
        throw new TypeError('image search copy must be an object');
      }
      if (!Array.isArray(imagePlan) || imagePlan.length < 3 || imagePlan.length > 5) {
        throw new RangeError('image search imagePlan must contain between 3 and 5 items');
      }
      const searchInput = {
        query: normalizedQuery,
        title: String(copy.title ?? '').slice(0, 100),
        body: String(copy.body ?? '').slice(0, 1_500),
        pages: imagePlan.map((item, index) => ({
          pageIndex: index + 1,
          kind: String(item?.kind ?? '').slice(0, 40),
          headline: String(item?.headline ?? '').slice(0, 100),
          subtitle: String(item?.subtitle ?? '').slice(0, 150),
          bullets: Array.isArray(item?.bullets)
            ? item.bullets.map((bullet) => String(bullet).slice(0, 100)).slice(0, 5)
            : [],
          prompt: String(item?.prompt ?? '').slice(0, 1_000),
        })),
      };
      const prompt = `请使用联网搜索，为下面每一页配图策划寻找可直接下载的相关图片。这只是内部流程联调，不是正式生图。只返回合法 JSON，不要 Markdown。\n\n<untrusted_image_brief>\n${JSON.stringify(searchInput)}\n</untrusted_image_brief>\n\n返回格式：{"pages":[{"pageIndex":1,"searchQuery":"实际检索词","candidates":[{"imageUrl":"可直接返回图片二进制的公开 HTTP(S) URL","sourcePageUrl":"包含该图片与授权说明的公开页面 URL","title":"图片标题","attribution":"作者或来源机构","license":"公开标注的许可证或使用说明"}]}]}。必须覆盖第 1 到 ${imagePlan.length} 页且顺序一致，每页返回 2 至 4 个不同候选。imageUrl 必须是图片原文件地址，不能是搜索结果页、data URL 或需要登录的地址；优先 Wikimedia Commons、Unsplash、Pexels 等有清楚来源和使用说明的公开图片，避免人物肖像、品牌标志、水印和敏感内容，不得编造 URL。`;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const repairInstruction = attempt === 1
          ? ''
          : `\n\n上一次返回为空或结构校验失败。请重新联网搜索并返回完整 JSON；必须包含 ${imagePlan.length} 个 pages，每页至少一个可下载候选，不要解释、不要 Markdown。`;
        try {
          const generated = await createResponse({
            prompt: `${prompt}${repairInstruction}`,
            timeoutMs,
            webSearch: true,
          });
          return {
            provider: 'deepseek',
            model,
            attempts: attempt,
            result: parsedImageSearchResult(generated.rawText, imagePlan.length),
          };
        } catch (error) {
          lastError = error;
          if (!retryableImageSearchError(error) || attempt === 3) break;
        }
      }
      throw new TypeError('DeepSeek image search did not return a valid result after 3 attempts', {
        cause: lastError,
      });
    },
  };
}
