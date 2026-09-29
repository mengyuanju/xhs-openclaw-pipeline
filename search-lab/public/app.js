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
  copyConfiguration: document.getElementById('copy-configuration'),
  copyConfigError: document.getElementById('copy-config-error'),
  copyConfigMessage: document.getElementById('copy-config-message'),
  retryCopyConfig: document.getElementById('retry-copy-config'),
  refreshCopyConfig: document.getElementById('refresh-copy-config'),
  copyRequirements: document.getElementById('copy-requirements'),
  copyCategory: document.getElementById('copy-category'),
  copyAudience: document.getElementById('copy-audience'),
  copyImageCount: document.getElementById('copy-image-count'),
  copyTextReview: document.getElementById('copy-text-review'),
  copyAutoRevise: document.getElementById('copy-auto-revise'),
  copyDescription: document.getElementById('copy-system-description'),
  systemPrompts: document.getElementById('system-prompts'),
  systemPromptContent: document.getElementById('system-prompt-content'),
  copyBatchToolbar: document.getElementById('copy-batch-toolbar'),
  copyBatchDescription: document.getElementById('copy-batch-description'),
  generateAllButton: document.getElementById('generate-all-button'),
};

const state = {
  providers: [],
  controls: new Map(),
  controller: null,
  running: false,
  lastQuery: '',
  results: new Map(),
  copyCards: new Map(),
  jobs: new Map(),
  copyConfig: null,
  copyControls: null,
  copyLoading: true,
  secrets: new Set(),
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
    .concat(state.copyControls?.keyInput.value.trim(), [...state.secrets])
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
  dom.compareButton.disabled = state.running || hasActiveCopyJobs() || selected.length === 0 || incomplete > 0;
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
      type: field.type === 'boolean' ? 'boolean' : 'string',
      label: textValue(field.label).trim() || name,
      description: textValue(field.description).trim(),
      defaultValue: field.defaultValue === true,
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

function createBooleanField({ label, description, defaultValue = false }) {
  const container = node('div', 'provider-field provider-boolean-field');
  const fieldLabel = node('label', 'provider-option');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = defaultValue;
  const caption = node('span');
  caption.append(node('span', 'provider-option-label', label));
  if (description) caption.append(node('span', 'provider-option-description', description));
  fieldLabel.append(input, caption);
  container.append(fieldLabel);
  return { container, input };
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
    if (field.type === 'boolean') continue;
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
    const { container, input, hint } = field.type === 'boolean'
      ? createBooleanField(field) : createTextField(field);
    input.setAttribute('aria-label', `${provider.label} ${field.label}`);
    fields.append(container);
    control.options.set(field.name, input);
    control.optionHints.set(field.name, hint);
    input.addEventListener(field.type === 'boolean' ? 'change' : 'input', updateSelectedCount);
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
  if (key) {
    selected.key = key;
    state.secrets.add(key);
  }
  if (model) selected.model = model;
  if (control.options.size > 0) {
    const options = Object.create(null);
    for (const [name, input] of control.options) {
      if (input.type === 'checkbox') {
        options[name] = input.checked;
        continue;
      }
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
  state.results.clear();
  state.copyCards.clear();
  state.jobs.clear();
  dom.copyBatchToolbar.hidden = true;
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
  if (kind === 'completed') body.append(createCopyPanel(provider, result));
  else body.append(node('p', 'copy-unavailable-note', '取得可用搜索资料后即可生成最终文案。'));
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
  state.lastQuery = textValue(response?.query).trim() || dom.query.value.trim();
  state.results = byId;
  state.copyCards.clear();
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
  dom.copyBatchToolbar.hidden = completed === 0;
  updateCopyActions();
}

function renderRequestError(message) {
  dom.copyBatchToolbar.hidden = true;
  dom.resultStats.hidden = true;
  dom.resultSubtitle.textContent = '本次搜索未能完成。';
  const empty = node('div', 'empty-state');
  empty.append(node('h3', '', '请求未完成'), node('p', '', message));
  dom.results.replaceChildren(empty);
}

async function compare(event) {
  event.preventDefault();
  if (state.running || hasActiveCopyJobs()) return;
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
    updateCopyActions();
  }
}

function hasActiveCopyJobs() {
  return [...state.jobs.values()].some((job) => job.active);
}

function objectText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return redactKeys(value);
  try { return redactKeys(JSON.stringify(value, null, 2)); }
  catch { return ''; }
}

function generationProvider() {
  const providerId = state.copyControls?.providerSelect.value;
  return state.copyConfig?.providers.find((provider) => provider.id === providerId) || null;
}

function generationIsReady() {
  if (!state.copyConfig || !state.copyControls || state.copyLoading) return false;
  const provider = generationProvider();
  if (!provider) return false;
  if (provider.id === 'system' && state.copyConfig.configuration?.ready === false && !provider.needsKey) return false;
  const key = state.copyControls.keyInput.value.trim();
  const model = state.copyControls.modelInput.value.trim();
  const validKey = !provider.needsKey || Boolean(key && key.length <= 2048 && !/\s/u.test(key));
  const validModel = !provider.hasModel || !model || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model);
  state.copyControls.keyHint.textContent = !key ? '待填写生成服务 API Key（不会保存）'
    : validKey ? '已填写 Key（仅当前页面）' : 'Key 不可包含空格，且最多 2048 字符';
  state.copyControls.keyHint.classList.toggle('is-ready', Boolean(key && validKey));
  state.copyControls.modelHint.hidden = validModel;
  state.copyControls.modelHint.textContent = validModel ? '' : '模型 ID 格式不正确';
  return validKey && validModel;
}

function updateCopyActions() {
  const ready = generationIsReady();
  const active = hasActiveCopyJobs();
  const eligible = [...state.copyCards.keys()].filter((id) => !state.jobs.get(id)?.active);
  for (const [id, control] of state.copyCards) {
    const job = state.jobs.get(id);
    control.button.disabled = !ready || state.running || Boolean(job?.active);
    control.button.textContent = job?.active ? '正在生成…' : job ? '重新生成文案' : '生成最终文案';
  }
  dom.generateAllButton.disabled = !ready || state.running || active || eligible.length === 0;
  dom.generateAllButton.textContent = active ? '文案流程运行中…' : '为所有成功结果生成';
  const completed = [...state.jobs.values()].filter((job) => job.status === 'COMPLETED').length;
  const running = [...state.jobs.values()].filter((job) => job.active).length;
  dom.copyBatchDescription.textContent = running
    ? `${running} 份文案正在生成${completed ? `，${completed} 份已完成` : ''}。可在结果卡中查看各自的阶段。`
    : completed ? `${completed} 份文案已完成。可以复制、下载，或展开查看审核和本次使用的提示词。`
      : '选择某一张结果卡生成，也可以为所有成功结果生成文案。';
  if (state.copyControls) {
    state.copyControls.providerSelect.disabled = active;
    state.copyControls.modelInput.disabled = active;
    state.copyControls.keyInput.disabled = active;
  }
  dom.copyRequirements.disabled = active;
  dom.refreshCopyConfig.disabled = active || state.copyLoading;
  dom.copyCategory.disabled = active;
  dom.copyAudience.disabled = active;
  dom.copyImageCount.disabled = active;
  dom.copyTextReview.disabled = active;
  dom.copyAutoRevise.disabled = active || !dom.copyTextReview.checked;
  updateSelectedCount();
}

function renderPromptEntries(value, destination) {
  destination.replaceChildren();
  if (value && !Array.isArray(value) && typeof value === 'object') {
    const source = textValue(value.sourceLabel || value.source).trim();
    const capturedAt = textValue(value.capturedAt).trim();
    const knowledge = value.knowledgeEnabled === false ? '案例库：当前系统已关闭'
      : Number.isInteger(value.knowledgeCount) ? `案例库：${value.knowledgeCount} 条` : '';
    const meta = [source, capturedAt ? `读取时间：${capturedAt}` : '', knowledge].filter(Boolean);
    if (meta.length) destination.append(node('p', 'prompt-meta', redactKeys(meta.join(' · '))));
  }
  const entries = Array.isArray(value) ? value : Array.isArray(value?.prompts) ? value.prompts
    : Array.isArray(value?.entries) ? value.entries : [];
  if (entries.length) {
    for (const [index, entry] of entries.entries()) {
      const details = node('details', 'prompt-entry');
      const name = textValue(entry?.label || entry?.name || entry?.key || entry?.stage).trim() || `提示词 ${index + 1}`;
      const version = textValue(entry?.version || entry?.versionId || entry?.hash).trim();
      details.append(node('summary', '', redactKeys(`${name}${version ? ` · ${version}` : ''}`)));
      const content = textValue(entry?.content || entry?.text || entry?.prompt || entry?.systemPrompt);
      details.append(node('pre', 'prompt-original', content ? redactKeys(content) : objectText(entry)));
      const provenance = entry?.provenance || (entry?.source || entry?.sha256 ? { source: entry.source, sha256: entry.sha256 } : null);
      if (provenance) details.append(dataDetails('提示词版本与来源', provenance, `prompt-version-${index}`));
      if (entry?.outputSchema) details.append(dataDetails('本次输出结构要求', entry.outputSchema, `prompt-schema-${index}`));
      if (entry?.rawOutput) details.append(dataDetails('模型原始输出', entry.rawOutput, `prompt-output-${index}`));
      destination.append(details);
    }
  } else if (value && typeof value === 'object') {
    destination.append(node('pre', 'prompt-original', objectText(value)));
  } else {
    destination.append(node('p', 'copy-note', redactKeys(value) || '本次没有可展示的提示词记录。'));
  }
}

function renderCopyConfiguration() {
  const configuration = state.copyConfig.configuration;
  const fields = node('div', 'generation-grid');
  const providerField = node('label', 'field-wrap');
  providerField.append(node('span', 'input-label', '文案生成服务'));
  const providerSelect = node('select', 'control-input');
  providerSelect.id = 'generation-provider';
  for (const provider of state.copyConfig.providers) {
    const option = node('option', '', provider.label);
    option.value = provider.id;
    providerSelect.append(option);
  }
  providerSelect.value = state.copyConfig.providers.some((provider) => provider.id === 'system')
    ? 'system' : state.copyConfig.providers[0].id;
  providerField.append(providerSelect);
  const modelField = createTextField({ label: '生成模型', placeholder: '使用服务商默认模型' });
  modelField.input.id = 'generation-model';
  const keyField = createTextField({ label: '生成服务 API Key', placeholder: '粘贴生成服务的 Key', secret: true });
  keyField.input.id = 'generation-key';
  const keyHint = node('p', 'key-hint', '待填写生成服务 API Key（不会保存）');
  keyField.container.append(keyHint);
  const summary = node('div', 'generation-system-summary');
  summary.append(node('span', 'generation-system-label', '当前系统配置'));
  const systemName = textValue(configuration?.label || configuration?.provider).trim() || '本机生成服务';
  summary.append(node('strong', '', redactKeys(`${systemName}${configuration?.model ? ` · ${configuration.model}` : ''}`)));
  summary.append(node('p', '', '沿用生产系统的 Query 审核、资料检查、文案生成、审核与修复流程。'));
  if (configuration?.warning) summary.append(node('p', 'configuration-warning', redactKeys(configuration.warning)));
  if (configuration?.reviewModel) summary.append(node('small', '', `审核模型：${redactKeys(configuration.reviewModel)}`));
  const promptInfo = state.copyConfig.promptInfo;
  if (promptInfo?.knowledgeEnabled === false) summary.append(node('small', '', '案例库：当前系统已关闭'));
  else if (Number.isInteger(promptInfo?.knowledgeCount)) summary.append(node('small', '', `案例库：${promptInfo.knowledgeCount} 条`));
  fields.append(providerField, modelField.container, keyField.container, summary);
  state.copyControls = { providerSelect, modelInput: modelField.input, modelHint: modelField.hint, keyInput: keyField.input, keyHint };
  const selectProvider = () => {
    const provider = generationProvider();
    modelField.container.hidden = !provider?.hasModel;
    keyField.container.hidden = !provider?.needsKey;
    modelField.input.value = provider?.defaultModel || '';
    summary.hidden = provider?.id !== 'system';
    const description = provider?.description;
    dom.copyDescription.textContent = description
      ? `${description} 点击生成按钮后才会调用文案模型。`
      : '点击生成按钮后才会调用文案模型；当前页面的 Key 不会写入本地存储。';
    updateCopyActions();
  };
  providerSelect.addEventListener('change', selectProvider);
  modelField.input.addEventListener('input', updateCopyActions);
  keyField.input.addEventListener('input', updateCopyActions);
  dom.copyConfiguration.replaceChildren(fields);
  selectProvider();
  if (state.copyConfig.promptInfo) {
    dom.systemPrompts.hidden = false;
    renderPromptEntries(state.copyConfig.promptInfo, dom.systemPromptContent);
  }
}

function applyCopyConfiguration(data) {
  const previous = state.copyControls ? {
    provider: state.copyControls.providerSelect.value,
    key: state.copyControls.keyInput.value,
    model: state.copyControls.modelInput.value,
  } : null;
  const seen = new Set();
  const providers = (Array.isArray(data?.providers) ? data.providers : []).flatMap((provider) => {
    const id = textValue(provider?.id).trim();
    const label = textValue(provider?.label).trim();
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label, needsKey: provider.needsKey === true, hasModel: provider.hasModel === true,
      defaultModel: textValue(provider.defaultModel), description: textValue(provider.description) }];
  });
  if (!providers.length) throw new Error('当前没有可用的文案生成服务。');
  state.copyConfig = { ...data, providers };
  state.copyLoading = false;
  renderCopyConfiguration();
  if (previous && providers.some((provider) => provider.id === previous.provider)) {
    state.copyControls.providerSelect.value = previous.provider;
    state.copyControls.providerSelect.dispatchEvent(new Event('change'));
    state.copyControls.keyInput.value = previous.key;
    state.copyControls.modelInput.value = previous.model;
  }
}

async function loadCopyConfiguration() {
  if (hasActiveCopyJobs()) return;
  state.copyLoading = true;
  dom.copyConfigError.hidden = true;
  updateCopyActions();
  try {
    const response = await fetch('/api/copy-config', { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(textValue(data?.error?.message || data?.error || data?.message) || `服务返回 HTTP ${response.status}。`);
    applyCopyConfiguration(data);
  } catch (error) {
    state.copyConfig = null;
    dom.copyConfiguration.replaceChildren();
    dom.copyConfigMessage.textContent = `无法读取生成配置：${redactKeys(error?.message) || '请确认本地测试服务已启动。'}`;
    dom.copyConfigError.hidden = false;
  } finally {
    state.copyLoading = false;
    updateCopyActions();
  }
}

function generationPayload() {
  const provider = generationProvider();
  const generation = { provider: provider.id };
  const key = state.copyControls.keyInput.value.trim();
  const model = state.copyControls.modelInput.value.trim();
  if (provider.needsKey && key) {
    generation.key = key;
    state.secrets.add(key);
  }
  if (provider.hasModel && model) generation.model = model;
  return generation;
}

function createCopyPanel(provider, searchResult) {
  const panel = node('section', 'copy-result-panel');
  panel.setAttribute('aria-label', `${provider.label} 最终文案`);
  const header = node('div', 'copy-result-heading');
  header.append(node('h4', '', '最终文案'));
  const button = node('button', 'button button-primary button-compact', '生成最终文案');
  button.type = 'button';
  button.disabled = true;
  const content = node('div', 'copy-job-content');
  content.append(node('p', 'copy-placeholder', '使用这家的搜索资料，运行当前系统的完整文案流程。'));
  header.append(button);
  panel.append(header, content);
  state.copyCards.set(provider.id, { panel, content, button, provider, research: searchResult.snapshot });
  button.addEventListener('click', () => {
    if (generationIsReady()) startCopyJob(provider.id, generationPayload(), dom.copyRequirements.value.trim());
  });
  return panel;
}

const STAGE_LABELS = {
  QUEUED: '等待生成', STARTING: '准备生成', QUERY_REVIEW: 'Query 审核', REVIEW_QUERY: 'Query 审核',
  RESEARCH: '资料检查', RESEARCH_CHECK: '资料检查', COPY: '生成文案', COPY_GENERATION: '生成文案',
  GENERATE_COPY: '生成文案', TEXT_GENERATION: '生成文案', TEXT_REVIEW: '文案审核', REVIEW_TEXT: '文案审核',
  REPAIR: '修复文案', TEXT_REPAIR: '修复文案', COPY_REPAIR: '修复文案',
  IMAGE_PLAN: '配图文字规划', IMAGE_PLANNING: '配图文字规划', DYNAMIC_IMAGE_PLAN: '配图文字规划',
  COMPLETED: '文案流程已完成', FAILED: '文案流程未通过', RUNNING: '文案流程运行中',
  KNOWLEDGE_MATCH: '文案案例匹配', ORIGINAL_GENERATION: '首稿生成',
  COPY_LENGTH_REPAIR: '正文字数修复', COPY_CONTRACT_REPAIR: '文案结构修复',
  ORIGINAL_REVIEW: '首稿审核', REVIEWED_GENERATION: '质检修订',
  REVIEWED_REVIEW: '修订复检', FINAL_IMAGE_PLAN: '最终配图文字规划',
};

function stageLabel(stage) {
  const raw = textValue(stage).trim();
  return STAGE_LABELS[raw.toUpperCase().replaceAll('-', '_')] || redactKeys(raw) || '准备生成';
}

function dataDetails(title, value, name) {
  const details = node('details', 'copy-data-details');
  details.dataset.section = name;
  details.append(node('summary', '', title), node('pre', 'copy-data-original', objectText(value)));
  return details;
}

function postText(post) {
  const tags = Array.isArray(post?.tags) ? post.tags.map((tag) => redactKeys(tag)).filter(Boolean) : [];
  return [redactKeys(post?.title).trim(), redactKeys(post?.body).trim(), tags.join(' ')].filter(Boolean).join('\n\n');
}

function renderPost(post, provider, final = true) {
  const preview = node('div', 'final-post');
  const title = redactKeys(post?.title).trim();
  const body = redactKeys(post?.body).trim();
  preview.append(node('span', 'final-post-label', final ? '最终标题' : '本次生成标题'));
  preview.append(node('h4', 'final-post-title', title || '未返回标题'));
  preview.append(node('p', 'final-post-body', body || '未返回正文'));
  const tags = node('div', 'final-post-tags');
  if (Array.isArray(post?.tags)) for (const tag of post.tags) {
    const label = redactKeys(tag).trim();
    if (label) tags.append(node('span', '', label));
  }
  if (tags.childElementCount) preview.append(tags);
  const actions = node('div', 'final-post-actions');
  const copyLabel = final ? '复制最终文案' : '复制生成稿';
  const copy = node('button', 'button button-subtle button-compact', copyLabel);
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(postText(post)); copy.textContent = '已复制'; }
    catch { copy.textContent = '复制失败'; }
    setTimeout(() => { copy.textContent = copyLabel; }, 1800);
  });
  const download = node('button', 'button button-subtle button-compact', '下载 TXT');
  download.type = 'button';
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([postText(post)], { type: 'text/plain;charset=utf-8' }));
    const link = node('a');
    link.href = url;
    link.download = `${final ? '最终文案' : '生成稿'}-${provider.id.replace(/[^A-Za-z0-9_-]/gu, '-')}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  actions.append(copy, download);
  preview.append(actions);
  return preview;
}

function renderStageReviews(reviews) {
  const section = node('div', 'copy-reviews');
  section.append(resultSectionTitle('文案流程审核'));
  const entries = Array.isArray(reviews) ? reviews.map((review, index) => [textValue(review?.stage) || `${index + 1}`, review])
    : reviews && typeof reviews === 'object' ? Object.entries(reviews) : [];
  for (const [name, review] of entries) {
    if (!review) continue;
    const decision = textValue(review?.decision || review?.status).toUpperCase();
    const skipped = review?.skipped === true || decision === 'SKIPPED';
    const item = node('div', `review-summary ${skipped ? 'is-skipped' : decision === 'PASS' ? 'is-good' : 'is-risk'}`);
    const heading = node('div', 'review-summary-heading');
    const labels = { query: 'Query 审核', text: '最终文案审核', originalText: '原稿审核', reviewedText: '修订稿审核' };
    heading.append(node('strong', '', labels[name] || stageLabel(name)));
    heading.append(node('span', '', skipped ? '已跳过' : decision === 'PASS' ? '通过' : decision === 'REJECT' ? '拒绝' : decision === 'REPAIR' ? '需修复' : redactKeys(decision) || '已完成'));
    item.append(heading);
    const reason = textValue(review?.reason || review?.summary || review?.conclusion);
    if (reason) item.append(node('p', '', redactKeys(reason)));
    item.append(dataDetails('展开审核详情', review, `review-${name}`));
    section.append(item);
  }
  return section;
}

function renderImagePlan(plan) {
  const details = node('details', 'copy-data-details image-plan-details');
  details.dataset.section = 'image-plan';
  details.append(node('summary', '', `配图文字规划（${plan.length} 页）`));
  const list = node('ol', 'image-plan-list');
  for (const [index, page] of plan.entries()) {
    const item = node('li', 'image-plan-page');
    item.append(node('span', 'image-page-index', `第 ${index + 1} 页${page?.kind ? ` · ${redactKeys(page.kind)}` : ''}`));
    item.append(node('strong', '', redactKeys(page?.headline) || '未命名页面'));
    if (page?.subtitle) item.append(node('p', '', redactKeys(page.subtitle)));
    if (Array.isArray(page?.bullets)) {
      const bullets = node('ul');
      for (const bullet of page.bullets) bullets.append(node('li', '', redactKeys(bullet)));
      item.append(bullets);
    }
    item.append(dataDetails('查看本页完整规划', page, `image-page-${index}`));
    list.append(item);
  }
  details.append(list);
  return details;
}

function renderCopyJob(providerId, data) {
  const control = state.copyCards.get(providerId);
  if (!control) return;
  const expanded = new Set([...control.content.querySelectorAll('details[open]')].map((item) => item.dataset.section).filter(Boolean));
  const result = data?.result && typeof data.result === 'object' ? data.result : {};
  const revisionUnchanged = result.revisionUnchanged === true || result?.generation?.revisionUnchanged === true;
  const status = textValue(data?.status).toUpperCase();
  const resultStatus = textValue(data?.result?.status).toUpperCase();
  const qualityStatus = textValue(data?.result?.qualityStatus).toUpperCase();
  const rejected = ['REJECTED'].includes(status) || ['REJECTED'].includes(resultStatus)
    || qualityStatus === 'REJECT'
    || textValue(data?.result?.review?.decision || data?.result?.stageReviews?.text?.decision).toUpperCase() === 'REJECT';
  const failed = ['FAILED', 'REJECTED'].includes(status) || ['FAILED', 'REJECTED'].includes(resultStatus) || rejected;
  const completed = status === 'COMPLETED' && !failed;
  const fragment = document.createDocumentFragment();
  const progress = node('div', `copy-progress ${completed ? qualityStatus === 'SKIPPED' ? 'is-skipped' : 'is-completed' : failed ? 'is-failed' : ''}`);
  if (!completed && !failed) progress.append(node('span', 'spinner'));
  const progressText = node('div');
  const completeLabel = qualityStatus === 'SKIPPED' ? '文案已生成 · 未启用自动审核'
    : qualityStatus === 'PASS' ? '文案已生成 · 审核通过' : stageLabel(data?.stage || status);
  progressText.append(node('strong', '', revisionUnchanged ? '修订未产生修改，已保留原稿' : failed ? (rejected ? '文案审核未通过' : '文案流程未完成') : completed ? completeLabel : stageLabel(data?.stage || status)));
  const lastEvent = Array.isArray(data?.events) ? data.events[data.events.length - 1] : null;
  const eventText = textValue(lastEvent?.message || lastEvent?.label || lastEvent?.details?.message || lastEvent?.details?.reason || data?.message);
  if (eventText) progressText.append(node('p', '', redactKeys(eventText)));
  progress.append(progressText);
  fragment.append(progress);
  if (state.jobs.get(providerId)?.configurationRefreshed) {
    fragment.append(node('p', 'copy-revision-note', '已自动更新过期的生成配置，本次使用最新系统提示词继续生成。'));
  }
  if (data?.error) fragment.append(node('p', 'result-error', objectText(data.error)));
  const model = result?.generation?.model || result?.generationSettings?.model;
  const runMeta = [model ? `生成模型：${redactKeys(model)}` : '', Number.isFinite(result.durationMs) ? `生成耗时：${durationLabel(result.durationMs)}` : ''].filter(Boolean);
  if (runMeta.length) fragment.append(node('p', 'copy-model-note', runMeta.join(' · ')));
  if (result.error && !data?.error) fragment.append(node('p', 'result-error', objectText(result.error)));
  const post = result?.post?.value || result?.post;
  if (post && typeof post === 'object') {
    if (!completed) fragment.append(node('p', 'copy-draft-note', '流程尚未通过，以下为本次生成稿；请结合审核结论查看。'));
    fragment.append(renderPost(post, control.provider, completed));
  }
  if (revisionUnchanged) {
    fragment.append(node('p', 'copy-revision-note', '两次修订均未产生实际修改。原稿与审核问题已保留，修订输出未进行复检；可调整要求后重新生成。'));
  } else if (result?.generation?.revisionAttempted) {
    fragment.append(node('p', 'copy-revision-note', '本次已按原稿审核意见自动修订一次。展开下方原稿与修订稿可查看变化。'));
  }
  for (const [name, label] of [['original', '生成原稿'], ['reviewed', revisionUnchanged ? '未改变的修订输出' : '审核后修订稿']]) {
    const version = result[name];
    if (!version?.copy) continue;
    const details = node('details', 'copy-data-details copy-version');
    details.dataset.section = `version-${name}`;
    details.append(node('summary', '', label));
    details.append(renderPost(version.copy, control.provider, false));
    if (version.review) details.append(dataDetails('该版本审核结论', version.review, `version-review-${name}`));
    fragment.append(details);
  }
  if (result.stageReviews) fragment.append(renderStageReviews(result.stageReviews));
  const repairs = result.repairHistory || result.repairs || result.repairAttempts || result.textRepair;
  if (repairs) fragment.append(dataDetails('文案修复过程', repairs, 'repairs'));
  if (result?.generation) fragment.append(dataDetails('生成设置、修订记录与耗时', result.generation, 'generation'));
  if (Array.isArray(result?.stages) && result.stages.length) fragment.append(dataDetails('各阶段执行结果', result.stages, 'stages'));
  const imagePlan = post?.imagePlan || result.imagePlan;
  if (Array.isArray(imagePlan) && imagePlan.length) fragment.append(renderImagePlan(imagePlan));
  if (Array.isArray(data?.events) && data.events.length) {
    const timeline = node('details', 'copy-data-details copy-timeline');
    timeline.dataset.section = 'timeline';
    timeline.append(node('summary', '', `流程记录（${data.events.length}）`));
    const list = node('ol');
    for (const event of data.events) {
      const item = node('li');
      item.append(node('strong', '', stageLabel(event?.stage || event?.type)));
      const message = event?.message || event?.label || event?.details?.message || event?.details?.reason;
      item.append(node('span', '', redactKeys(message) || '阶段已记录'));
      list.append(item);
    }
    timeline.append(list);
    fragment.append(timeline);
  }
  const prompts = data?.prompts || result.prompts;
  if (prompts) {
    const details = node('details', 'copy-data-details job-prompts');
    details.dataset.section = 'job-prompts';
    details.append(node('summary', '', '本次使用的提示词原文与版本'));
    const content = node('div', 'prompt-content');
    renderPromptEntries(prompts, content);
    details.append(content);
    fragment.append(details);
  }
  if (result.promptProvenance) fragment.append(dataDetails('本次提示词版本快照', result.promptProvenance, 'prompt-provenance'));
  control.content.replaceChildren(fragment);
  for (const item of control.content.querySelectorAll('details')) {
    if (expanded.has(item.dataset.section)) item.open = true;
  }
}

async function startCopyJob(providerId, generation, requirements) {
  const control = state.copyCards.get(providerId);
  if (!control || state.jobs.get(providerId)?.active || state.running) return;
  const job = { active: true, status: 'RUNNING', jobId: null };
  state.jobs.set(providerId, job);
  renderCopyJob(providerId, { status: 'RUNNING', stage: 'STARTING' });
  updateCopyActions();
  try {
    const response = await fetch('/api/copy-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ configurationId: state.copyConfig.configurationId,
        query: state.lastQuery, research: control.research,
        researchProvider: { id: control.provider.id, label: control.provider.label }, generation, requirements,
        input: { category: dom.copyCategory.value.trim(), targetAudience: dom.copyAudience.value.trim() },
        requestedImageCount: dom.copyImageCount.value === 'auto' ? 'auto' : Number(dom.copyImageCount.value),
        textReviewEnabled: dom.copyTextReview.checked,
        autoReviseOnReject: dom.copyTextReview.checked && dom.copyAutoRevise.checked }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.jobId) throw new Error(textValue(data?.error?.message || data?.error || data?.message) || `无法创建文案任务（HTTP ${response.status}）。`);
    job.jobId = textValue(data.jobId) || String(data.jobId);
    job.configurationRefreshed = data.configurationRefreshed === true;
    if (job.configurationRefreshed && data.copyConfiguration) {
      try { applyCopyConfiguration(data.copyConfiguration); }
      catch {
        // A configuration display error must not abandon an accepted model job.
        if (state.copyConfig && data.configurationId) state.copyConfig.configurationId = data.configurationId;
      }
      updateCopyActions();
    }
    while (job.active) {
      const poll = await fetch(`/api/copy-jobs/${encodeURIComponent(job.jobId)}`, { cache: 'no-store' });
      const progress = await poll.json().catch(() => null);
      if (!poll.ok || !progress?.status) throw new Error(textValue(progress?.error?.message || progress?.error || progress?.message) || `无法读取文案进度（HTTP ${poll.status}）。`);
      job.status = textValue(progress.status).toUpperCase();
      renderCopyJob(providerId, progress);
      if (['COMPLETED', 'FAILED', 'REJECTED'].includes(job.status)) {
        job.active = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
  } catch (error) {
    job.status = 'FAILED';
    job.active = false;
    renderCopyJob(providerId, { status: 'FAILED', stage: 'FAILED', error: redactKeys(error?.message) || '文案流程请求失败。' });
  } finally {
    updateCopyActions();
  }
}

dom.form.addEventListener('submit', compare);
dom.query.addEventListener('input', () => {
  dom.queryCount.textContent = `${dom.query.value.length} / 500`;
  if (dom.formMessage.textContent) showMessage('');
});
dom.cancelButton.addEventListener('click', () => state.controller?.abort());
dom.retryProviders.addEventListener('click', loadProviders);
dom.retryCopyConfig.addEventListener('click', loadCopyConfiguration);
dom.refreshCopyConfig.addEventListener('click', loadCopyConfiguration);
dom.copyTextReview.addEventListener('change', updateCopyActions);
dom.generateAllButton.addEventListener('click', () => {
  if (!generationIsReady() || hasActiveCopyJobs() || state.running) return;
  const generation = generationPayload();
  const requirements = dom.copyRequirements.value.trim();
  for (const providerId of state.copyCards.keys()) startCopyJob(providerId, generation, requirements);
});
loadProviders();
loadCopyConfiguration();
