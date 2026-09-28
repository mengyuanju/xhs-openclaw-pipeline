const dom = {
  form: document.getElementById('compare-form'),
  query: document.getElementById('query-input'),
  queryCount: document.getElementById('query-count'),
  providers: document.getElementById('provider-list'),
  providerError: document.getElementById('provider-load-error'),
  providerErrorMessage: document.getElementById('provider-load-message'),
  retryProviders: document.getElementById('retry-providers'),
  selectedCount: document.getElementById('selected-count'),
  compareButton: document.getElementById('compare-button'),
  cancelButton: document.getElementById('cancel-button'),
  formMessage: document.getElementById('form-message'),
  resultSubtitle: document.getElementById('result-subtitle'),
  resultStats: document.getElementById('result-stats'),
  results: document.getElementById('results'),
};

const state = {
  providers: [],
  controls: new Map(),
  controller: null,
  running: false,
};

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = String(value);
  return item;
}

function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function redactKeys(value) {
  let result = textValue(value);
  const keys = [...state.controls.values()]
    .map((control) => control.keyInput?.value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const key of keys) result = result.split(key).join('[已隐藏 Key]');
  return result;
}

function showMessage(message) {
  dom.formMessage.textContent = message;
  dom.formMessage.hidden = !message;
}

function selectedProviders() {
  return state.providers.filter((provider) => state.controls.get(provider.id)?.checkbox.checked);
}

function updateSelectedCount() {
  const selected = selectedProviders();
  const incomplete = selected.filter((provider) => !providerIsReady(provider)).length;
  dom.selectedCount.textContent = `已选 ${selected.length} / ${state.providers.length} 家${incomplete ? ` · ${incomplete} 家待完善` : ''}`;
  dom.selectedCount.classList.toggle('is-incomplete', incomplete > 0);
  dom.compareButton.disabled = state.running || selected.length === 0 || incomplete > 0;
}

function normalizedProvider(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = textValue(item.id).trim();
  const label = textValue(item.label).trim();
  if (!id || !label) return null;
  const seenFields = new Set();
  const fields = (Array.isArray(item.fields) ? item.fields : []).flatMap((field) => {
    const name = textValue(field?.name).trim();
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name) || seenFields.has(name)) return [];
    seenFields.add(name);
    return [{
      name,
      label: textValue(field.label).trim() || name,
      placeholder: textValue(field.placeholder),
      required: field.required === true,
      secret: field.secret === true,
      pattern: textValue(field.pattern),
    }];
  });
  return {
    id,
    label,
    description: textValue(item.description).trim(),
    kind: textValue(item.kind),
    needsKey: item.needsKey === true,
    hasModel: item.hasModel === true,
    defaultModel: textValue(item.defaultModel).trim(),
    documentationUrl: safeExternalUrl(item.documentationUrl),
    fields,
  };
}

function createTextField({ label, placeholder, value = '', required = false, secret = false }) {
  const container = node('div', 'provider-field');
  const fieldLabel = node('label', 'field-wrap');
  const caption = node('span', 'field-label');
  const title = node('span', '', label);
  if (required) title.append(node('span', 'required', ' *'));
  caption.append(title);
  fieldLabel.append(caption);
  const input = node('input', 'control-input');
  input.type = secret ? 'password' : 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  fieldLabel.append(input);
  const hint = node('p', 'required-hint');
  hint.hidden = true;
  container.append(fieldLabel, hint);
  return { container, input, hint };
}

function fieldMatches(value, pattern) {
  if (!pattern || !value) return true;
  try { return new RegExp(pattern, 'u').test(value); }
  catch { return false; }
}

function providerIsReady(provider) {
  const control = state.controls.get(provider.id);
  if (!control) return false;
  let ready = true;
  if (provider.needsKey) {
    const key = control.keyInput.value.trim();
    const valid = key && key.length <= 2048 && !/\s/u.test(key);
    control.keyHint.textContent = !key ? '待输入 Key'
      : valid ? '已填写 Key（不会保存）' : 'Key 不可包含空格，且最多 2048 字符';
    control.keyHint.classList.toggle('is-ready', Boolean(valid));
    ready = Boolean(valid) && ready;
  }
  if (provider.hasModel) {
    const model = control.modelInput.value.trim();
    const valid = !model || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model);
    control.modelHint.hidden = valid;
    control.modelHint.textContent = valid ? '' : '模型 ID 格式不正确';
    ready = valid && ready;
  }
  for (const field of provider.fields) {
    const value = control.options.get(field.name).value.trim();
    const valid = (!field.required || Boolean(value)) && value.length <= 256 && fieldMatches(value, field.pattern);
    const hint = control.optionHints.get(field.name);
    hint.hidden = valid;
    hint.textContent = valid ? '' : !value ? `待填写${field.label}` : `${field.label}格式不正确`;
    ready = valid && ready;
  }
  return ready;
}

function createProviderCard(provider, index) {
  const card = node('article', 'provider-card');
  card.dataset.selected = 'false';

  const top = node('div', 'provider-top');
  const select = node('label', 'provider-select');
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  checkbox.checked = false;
  checkbox.setAttribute('aria-label', `比较 ${provider.label}`);
  const nameBlock = node('span');
  nameBlock.append(node('strong', '', provider.label), node('small', '', `PROVIDER ${String(index + 1).padStart(2, '0')}`));
  select.append(checkbox, nameBlock);
  top.append(select, node('span', 'provider-badge', provider.needsKey ? '需要 API Key' : '无需输入 Key'));
  card.append(top);
  card.append(node('p', 'provider-description', provider.description || '使用此服务商执行联网搜索。'));

  const fields = node('fieldset', 'provider-fields');
  fields.disabled = true;
  const control = {
    checkbox, keyInput: null, keyHint: null, modelInput: null, modelHint: null,
    options: new Map(), optionHints: new Map(),
  };

  if (provider.needsKey) {
    const field = node('div', 'provider-field');
    const keyLabel = node('label', 'field-label');
    keyLabel.append(node('span', '', 'API Key'), node('small', '', '仅当前页面'));
    const keyRow = node('div', 'key-field');
    const keyInput = node('input', 'control-input');
    keyInput.type = 'password';
    keyInput.placeholder = '粘贴服务商 Key';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyInput.setAttribute('aria-label', `${provider.label} API Key`);
    const keyToggle = node('button', 'key-toggle', '显示');
    keyToggle.type = 'button';
    keyToggle.setAttribute('aria-label', `显示 ${provider.label} API Key`);
    keyToggle.addEventListener('click', () => {
      const visible = keyInput.type === 'password';
      keyInput.type = visible ? 'text' : 'password';
      keyToggle.textContent = visible ? '隐藏' : '显示';
      keyToggle.setAttribute('aria-label', `${visible ? '隐藏' : '显示'} ${provider.label} API Key`);
    });
    const hint = node('p', 'key-hint', '待输入 Key');
    keyInput.addEventListener('input', updateSelectedCount);
    keyRow.append(keyInput, keyToggle);
    field.append(keyLabel, keyRow, hint);
    fields.append(field);
    control.keyInput = keyInput;
    control.keyHint = hint;
  }

  if (provider.hasModel) {
    const { container, input, hint } = createTextField({
      label: '模型',
      placeholder: provider.defaultModel || '输入模型名称',
      value: provider.defaultModel,
    });
    fields.append(container);
    control.modelInput = input;
    control.modelHint = hint;
    input.addEventListener('input', updateSelectedCount);
  }

  for (const field of provider.fields) {
    const { container, input, hint } = createTextField(field);
    input.setAttribute('aria-label', `${provider.label} ${field.label}`);
    fields.append(container);
    control.options.set(field.name, input);
    control.optionHints.set(field.name, hint);
    input.addEventListener('input', updateSelectedCount);
  }

  if (fields.childElementCount > 0) card.append(fields);
  if (provider.documentationUrl) {
    const doc = node('a', 'provider-doc-link', '查看接口说明 ↗');
    doc.href = provider.documentationUrl;
    doc.target = '_blank';
    doc.rel = 'noopener noreferrer';
    card.append(doc);
  }

  checkbox.addEventListener('change', () => {
    card.dataset.selected = String(checkbox.checked);
    fields.disabled = !checkbox.checked;
    updateSelectedCount();
  });
  state.controls.set(provider.id, control);
  return card;
}

async function loadProviders() {
  if (state.running) return;
  dom.providerError.hidden = true;
  dom.providers.replaceChildren(node('div', 'provider-loading', '正在读取可用服务商…'));
  dom.selectedCount.textContent = '正在加载…';
  dom.compareButton.disabled = true;
  state.providers = [];
  state.controls.clear();
  try {
    const response = await fetch('/api/providers', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data?.providers)) throw new Error(textValue(data?.error) || '服务商列表格式无效。');
    const seen = new Set();
    state.providers = data.providers.map(normalizedProvider).filter((provider) => {
      if (!provider || seen.has(provider.id)) return false;
      seen.add(provider.id);
      return true;
    });
    if (state.providers.length === 0) throw new Error('当前没有可用的搜索服务商。');
    dom.providers.replaceChildren(...state.providers.map(createProviderCard));
    updateSelectedCount();
  } catch (error) {
    dom.providers.replaceChildren();
    dom.providerErrorMessage.textContent = `无法读取服务商：${redactKeys(error?.message) || '请确认本地测试服务已启动。'}`;
    dom.providerError.hidden = false;
    dom.selectedCount.textContent = '未连接';
  }
}

function selectionPayload(provider) {
  const control = state.controls.get(provider.id);
  const selected = { id: provider.id };
  const key = control.keyInput?.value.trim();
  const model = control.modelInput?.value.trim();
  if (key) selected.key = key;
  if (model) selected.model = model;
  if (control.options.size > 0) {
    const options = Object.create(null);
    for (const [name, input] of control.options) {
      const value = input.value.trim();
      if (value) options[name] = value;
    }
    selected.options = options;
  }
  return selected;
}

function statusKind(result) {
  const status = textValue(result?.status || result?.snapshot?.status).toUpperCase();
  return ['COMPLETED', 'SUCCESS', 'OK'].includes(status) ? 'completed' : 'failed';
}

function durationLabel(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '耗时未知';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} 秒` : `${Math.round(value)} 毫秒`;
}

function resultShell(provider, kind, milliseconds) {
  const card = node('article', `result-card is-${kind}`);
  const header = node('header', 'result-card-header');
  const identity = node('div', 'result-provider');
  identity.append(node('span', 'result-monogram', [...provider.label][0] || '搜'));
  const name = node('div');
  const kindLabel = provider.kind === 'search-results' ? '网页摘要摘录'
    : provider.kind === 'model-answer' ? '模型联网回答' : '搜索输出';
  name.append(node('h3', '', provider.label), node('small', '', `${provider.id} · ${kindLabel}`));
  identity.append(name);
  const stateBlock = node('div', 'result-state');
  stateBlock.append(node('span', 'status-pill', kind === 'completed' ? '已完成' : kind === 'pending' ? '搜索中' : '未完成'));
  if (kind !== 'pending') stateBlock.append(node('span', 'duration', durationLabel(milliseconds)));
  header.append(identity, stateBlock);
  card.append(header);
  return card;
}

function renderPending(providers) {
  dom.resultStats.hidden = true;
  dom.resultSubtitle.textContent = `正在搜索「${dom.query.value.trim()}」；请等待各服务商返回。`;
  const cards = providers.map((provider) => {
    const card = resultShell(provider, 'pending');
    const body = node('div', 'result-body');
    const pending = node('div', 'pending-message');
    pending.append(node('span', 'spinner'), node('span', '', '正在等待 API 返回搜索结果…'));
    body.append(pending);
    card.append(body);
    return card;
  });
  dom.results.replaceChildren(...cards);
}

function resultSectionTitle(title, detail) {
  const heading = node('h4', 'result-section-title');
  heading.append(node('span', '', title));
  if (detail) heading.append(node('span', '', detail));
  return heading;
}

function renderSources(sources) {
  const list = node('ol', 'sources-list');
  for (const [index, source] of sources.entries()) {
    const item = node('li', 'source-item');
    item.append(node('span', 'source-index', String(index + 1).padStart(2, '0')));
    const content = node('div');
    const url = safeExternalUrl(source?.url);
    const hostname = url ? new URL(url).hostname : '';
    const title = redactKeys(source?.title).trim() || hostname || '未命名来源';
    if (url) {
      const link = node('a', 'source-title', title);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      content.append(link);
    } else {
      content.append(node('span', 'source-title', title));
    }
    content.append(node('span', 'source-site', redactKeys(source?.siteName).trim() || hostname || '来源链接不可用'));
    const snippet = redactKeys(source?.snippet).trim();
    if (snippet) content.append(node('p', 'source-snippet', snippet));
    item.append(content);
    list.append(item);
  }
  return list;
}

function renderAttempts(attempts) {
  const details = node('details', 'attempts');
  details.append(node('summary', '', `搜索尝试（${attempts.length}）`));
  const list = node('ul', 'attempt-list');
  for (const attempt of attempts) {
    const item = node('li', 'attempt-item');
    const completed = textValue(attempt?.status).toUpperCase() === 'COMPLETED';
    item.append(
      node('strong', '', redactKeys(attempt?.provider) || '未知服务商'),
      node('span', `attempt-status ${completed ? 'is-good' : 'is-risk'}`, completed ? '完成' : '失败'),
    );
    if (attempt?.error) item.append(node('span', 'attempt-error', redactKeys(attempt.error)));
    list.append(item);
  }
  details.append(list);
  return details;
}

function renderResult(provider, result) {
  const kind = statusKind(result);
  const hasPreview = kind === 'failed' && result?.preview && typeof result.preview === 'object';
  const card = resultShell(provider, kind, result?.durationMs);
  if (hasPreview) card.querySelector('.status-pill').textContent = '未通过规则';
  const body = node('div', 'result-body');
  const snapshot = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : {};
  const evidence = hasPreview ? result.preview : snapshot;
  const summary = redactKeys(evidence.summary).trim();
  const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
  const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];

  if (kind === 'failed') {
    const firstAttemptError = attempts.find((attempt) => attempt?.error)?.error;
    const reason = redactKeys(result?.error || firstAttemptError)
      || (result ? '本次搜索未取得可用的公开来源。' : '服务端未返回此服务商的结果。');
    body.append(node('p', 'result-error', reason));
    if (hasPreview) body.append(node('p', 'result-preview-note', '以下是服务商实际返回的公开资料；本次结果未通过当前系统的研究规则。'));
  }

  body.append(resultSectionTitle('搜索摘要', summary ? `${[...summary].length} 字` : '暂无摘要'));
  if (summary) {
    body.append(node('p', 'summary-text', summary));
    const actions = node('div', 'summary-actions');
    const copy = node('button', 'copy-button', '复制摘要');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(summary);
        copy.textContent = '已复制';
      } catch {
        copy.textContent = '复制失败';
      }
      setTimeout(() => { copy.textContent = '复制摘要'; }, 1800);
    });
    actions.append(copy);
    body.append(actions);
  } else {
    body.append(node('p', 'summary-text summary-empty', '该服务商未返回搜索摘要。'));
  }

  body.append(node('div', 'result-divider'));
  body.append(resultSectionTitle('公开来源', `${sources.length} 条`));
  body.append(sources.length ? renderSources(sources) : node('p', 'source-empty', '当前没有可展示的公开来源。'));
  if (attempts.length) body.append(renderAttempts(attempts));
  card.append(body);
  return card;
}

function statChip(label, value, tone) {
  const chip = node('div', `stat-chip ${tone || ''}`.trim());
  chip.append(node('span', '', label), node('strong', '', value));
  return chip;
}

function renderComparison(providers, response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const byId = new Map(results.map((result) => [result?.provider, result]));
  const cards = providers.map((provider) => renderResult(provider, byId.get(provider.id)));
  const completed = providers.filter((provider) => statusKind(byId.get(provider.id)) === 'completed').length;
  const sourceCount = providers.reduce((sum, provider) => {
    const result = byId.get(provider.id);
    const sources = (statusKind(result) === 'failed' && result?.preview?.sources)
      || result?.snapshot?.sources;
    return sum + (Array.isArray(sources) ? sources.length : 0);
  }, 0);
  dom.results.replaceChildren(...cards);
  dom.resultStats.replaceChildren(
    statChip('服务商', providers.length),
    statChip('搜索完成', completed, 'is-good'),
    statChip('未完成', providers.length - completed, providers.length === completed ? '' : 'is-risk'),
    statChip('公开来源', sourceCount),
  );
  dom.resultStats.hidden = false;
  dom.resultSubtitle.textContent = `Query：${textValue(response?.query).trim() || dom.query.value.trim()}`;
}

function renderRequestError(message) {
  dom.resultStats.hidden = true;
  dom.resultSubtitle.textContent = '本次搜索未能完成。';
  const empty = node('div', 'empty-state');
  empty.append(node('h3', '', '请求未完成'), node('p', '', message));
  dom.results.replaceChildren(empty);
}

async function compare(event) {
  event.preventDefault();
  if (state.running) return;
  const query = dom.query.value.trim();
  const providers = selectedProviders();
  if (!query) {
    showMessage('请先输入搜索 Query。');
    dom.query.focus();
    return;
  }
  if (query.length > 500) {
    showMessage('Query 最多 500 个字符。');
    dom.query.focus();
    return;
  }
  if (!providers.length) {
    showMessage('请至少选择一家搜索服务商。');
    return;
  }

  showMessage('');
  state.running = true;
  state.controller = new AbortController();
  dom.compareButton.disabled = true;
  dom.compareButton.firstElementChild.textContent = '正在搜索…';
  dom.cancelButton.hidden = false;
  renderPending(providers);
  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ query, providers: providers.map(selectionPayload) }),
      signal: state.controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(textValue(data?.error || data?.message) || `服务返回 HTTP ${response.status}。`);
    if (!Array.isArray(data?.results)) throw new Error('服务返回的结果格式无效。');
    renderComparison(providers, data);
  } catch (error) {
    const message = error?.name === 'AbortError' ? '已停止等待本次搜索。' : `请求失败：${redactKeys(error?.message) || '未知错误'}`;
    renderRequestError(message);
  } finally {
    state.running = false;
    state.controller = null;
    dom.cancelButton.hidden = true;
    dom.compareButton.firstElementChild.textContent = '开始对照搜索';
    updateSelectedCount();
  }
}

dom.form.addEventListener('submit', compare);
dom.query.addEventListener('input', () => {
  dom.queryCount.textContent = `${dom.query.value.length} / 500`;
  if (dom.formMessage.textContent) showMessage('');
});
dom.cancelButton.addEventListener('click', () => state.controller?.abort());
dom.retryProviders.addEventListener('click', loadProviders);
loadProviders();
