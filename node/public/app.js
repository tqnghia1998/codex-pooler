const form = document.querySelector('#upstream-form');
const type = document.querySelector('#type');
const codexFields = document.querySelector('#codex-fields');
const compassFields = document.querySelector('#compass-fields');
const cancelEdit = document.querySelector('#cancel-edit');
const formTitle = document.querySelector('#form-title');
const list = document.querySelector('#upstreams');
const message = document.querySelector('#message');
const bulkDialog = document.querySelector('#bulk-cap-dialog');
const bulkForm = document.querySelector('#bulk-cap-form');
const bulkMode = document.querySelector('#bulk-mode');
const bulkCapValue = document.querySelector('#bulk-cap-value');
const bulkCapValueField = document.querySelector('#bulk-cap-value-field');
const bulkRulesField = document.querySelector('#bulk-rules-field');
const bulkRules = document.querySelector('#bulk-rules');
const DEFAULT_BULK_RULES = [
  { minQuotaLeft: 1000, capDollars: 100 },
  { minQuotaLeft: 500, capDollars: 50 },
  { minQuotaLeft: 200, capDollars: 20 },
  { minQuotaLeft: 100, capDollars: 10 },
  { minQuotaLeft: 50, capDollars: 5 },
  { minQuotaLeft: 0, capDollars: 0 }
];
let editingId = null;
let loading = false;
let apiKey = sessionStorage.getItem('codex-pooler-api-key') || '';

const api = async (path, options = {}) => {
  const request = () => fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(options.headers || {}) }
  });
  let response = await request();
  if (response.status === 401) {
    apiKey = prompt('Enter the Codex Pooler API key')?.trim() || '';
    if (apiKey) {
      sessionStorage.setItem('codex-pooler-api-key', apiKey);
      response = await request();
    }
  }
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
};

function updateFields() {
  const isCodex = type.value === 'codex';
  codexFields.hidden = !isCodex;
  compassFields.hidden = isCodex;
}

type.addEventListener('change', updateFields);
cancelEdit.addEventListener('click', resetForm);
document.querySelector('#reload').addEventListener('click', load);
document.querySelector('#bulk-cap').addEventListener('click', bulkCaps);
document.querySelector('#cancel-bulk-cap').addEventListener('click', () => bulkDialog.close());
document.querySelector('#add-bulk-rule').addEventListener('click', () => addBulkRule());
bulkMode.addEventListener('change', updateBulkMode);
bulkRules.addEventListener('click', (event) => {
  if (event.target.closest('[data-remove-rule]')) event.target.closest('.bulk-rule').remove();
});
bulkForm.addEventListener('submit', saveBulkCaps);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (!data.authJson) delete data.authJson;
  if (!data.projectKey) delete data.projectKey;
  try {
    await api(editingId ? `/api/upstreams/${editingId}` : '/api/upstreams', {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(data)
    });
    show('Saved');
    resetForm();
    await load();
  } catch (error) { show(error.message, true); }
});

async function load() {
  if (loading) return;
  loading = true;
  try {
    const { upstreams } = await api('/api/upstreams');
    list.replaceChildren(...(upstreams.length ? upstreams.map(card) : [empty()]));
  } catch (error) { show(error.message, true); }
  finally { loading = false; }
}

function card(upstream) {
  const element = document.createElement('article');
  element.className = 'card';
  const quota = upstream.quota;
  const spending = upstream.spending;
  const left = quota ? `${formatPercent(quota.remainingPercent)} left` : 'Not refreshed';
  const count = quotaCount(quota);
  const used = quota ? Math.min(100, Math.max(0, quota.usedPercent)) : 0;
  const identity = upstream.type === 'compass' ? upstream.projectId : upstream.accountId;
  const capHeading = spending.capCredits > 0 ? `${formatPercent(spending.percentUsed)} used` : 'No spending cap';
  const capUsage = spending.capCredits > 0
    ? `$${formatNumber(spending.spentDollars)} / $${formatNumber(spending.capDollars)} used · ${spending.status} · started ${formatDate(spending.capStartedAt)} · ${spending.settlementCount} priced settlements`
    : 'Set a cap to make this upstream routable';
  element.innerHTML = `
    <h3></h3><span class="tag">${escapeHtml(upstream.type)}</span>
    <p class="muted">${escapeHtml(identity || 'No identifier')}</p>
    <div class="detail"><strong>${escapeHtml(left)}</strong><small>${escapeHtml(quota ? `${quota.label} · reset ${formatDate(quota.resetAt)}` : 'Click refresh to read provider quota')}</small>
      <div class="progress ${used >= 85 ? 'warn' : ''} ${used >= 100 ? 'bad' : ''}"><i style="width:${used}%"></i></div>
      ${count ? `<small class="quota-count">${escapeHtml(count)}</small>` : ''}
    </div>
    <div class="detail"><strong>${escapeHtml(capHeading)}</strong>
      <div class="progress ${spending.percentUsed >= 85 ? 'warn' : ''} ${spending.percentUsed >= 100 ? 'bad' : ''}"><i style="width:${Math.min(spending.percentUsed || 0, 100)}%"></i></div>
      <small class="quota-count">${escapeHtml(capUsage)}</small>
    </div>
    <div class="card-actions"><button data-action="refresh">Refresh quota</button><button data-action="edit">Edit</button><button data-action="cap">Set cap</button><button data-action="delete" class="danger">Delete</button></div>`;
  element.querySelector('h3').prepend(document.createTextNode(upstream.name));
  element.querySelector('[data-action=refresh]').onclick = () => run(async () => { await api(`/api/upstreams/${upstream.id}/refresh-quota`, { method: 'POST' }); await load(); }, 'Quota refreshed');
  element.querySelector('[data-action=edit]').onclick = () => edit(upstream);
  element.querySelector('[data-action=cap]').onclick = () => setCap(upstream);
  element.querySelector('[data-action=delete]').onclick = () => remove(upstream);
  return element;
}

async function setCap(upstream) {
  const value = window.prompt('Cap in USD (0 clears it)', upstream.spending.capDollars || '');
  if (value === null) return;
  await run(async () => { await api(`/api/upstreams/${upstream.id}/cap`, { method: 'PUT', body: JSON.stringify({ capDollars: value }) }); await load(); }, 'Cap updated');
}

function bulkCaps() {
  bulkMode.value = 'rules';
  bulkCapValue.value = '100';
  renderBulkRules(DEFAULT_BULK_RULES);
  updateBulkMode();
  bulkDialog.showModal();
}

function updateBulkMode() {
  const rules = bulkMode.value === 'rules';
  bulkRulesField.hidden = !rules;
  bulkCapValueField.hidden = rules;
}

function renderBulkRules(rules) {
  bulkRules.replaceChildren(...rules.map((rule) => {
    const row = document.createElement('div');
    row.className = 'bulk-rule';
    row.innerHTML = '<input data-field="minQuotaLeft" type="number" min="0" step="any" aria-label="Monthly quota left" placeholder="e.g. 1000"><input data-field="capDollars" type="number" min="0" step="any" aria-label="Spend cap" placeholder="e.g. 100"><button type="button" data-remove-rule aria-label="Remove rule">×</button>';
    row.querySelector('[data-field="minQuotaLeft"]').value = rule.minQuotaLeft;
    row.querySelector('[data-field="capDollars"]').value = rule.capDollars;
    return row;
  }));
}

function addBulkRule() {
  renderBulkRules([...readBulkRules(), { minQuotaLeft: '', capDollars: '' }]);
  bulkRules.lastElementChild?.querySelector('[data-field="minQuotaLeft"]')?.focus();
}

function readBulkRules() {
  return [...bulkRules.querySelectorAll('.bulk-rule')].map((row) => ({
    minQuotaLeft: row.querySelector('[data-field="minQuotaLeft"]').value,
    capDollars: row.querySelector('[data-field="capDollars"]').value
  }));
}

async function saveBulkCaps(event) {
  event.preventDefault();
  const mode = bulkMode.value;
  const payload = mode === 'rules'
    ? { rules: readBulkRules() }
    : { target: mode, capDollars: bulkCapValue.value };
  if (mode === 'rules' && (!payload.rules.length || payload.rules.some((rule) => rule.minQuotaLeft === '' || rule.capDollars === ''))) {
    show('Enter non-negative numbers for every quota and cap', true);
    return;
  }
  if (mode !== 'rules' && payload.capDollars === '') {
    show('Enter a cap amount', true);
    return;
  }
  await run(async () => {
    await api('/api/spending-caps/bulk', { method: 'POST', body: JSON.stringify(payload) });
    bulkDialog.close();
    await load();
  }, 'Bulk caps updated');
}

async function remove(upstream) {
  if (!window.confirm(`Delete ${upstream.name}?`)) return;
  await run(async () => { await api(`/api/upstreams/${upstream.id}`, { method: 'DELETE' }); await load(); }, 'Deleted');
}

function edit(upstream) {
  editingId = upstream.id;
  formTitle.textContent = 'Edit upstream';
  form.elements.type.value = upstream.type;
  form.elements.type.disabled = true;
  form.elements.authJson.value = '';
  form.elements.projectId.value = upstream.projectId || '';
  form.elements.projectKey.value = '';
  cancelEdit.hidden = false;
  updateFields();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editingId = null;
  form.reset();
  form.elements.type.value = 'codex';
  form.elements.type.disabled = false;
  formTitle.textContent = 'Add upstream';
  cancelEdit.hidden = true;
  updateFields();
}

function empty() { const element = document.createElement('div'); element.className = 'empty'; element.textContent = 'No upstreams yet.'; return element; }
function show(text, error = false) { message.textContent = text; message.className = `message${error ? ' error' : ''}`; }
async function run(action, success) { try { await action(); show(success); } catch (error) { show(error.message, true); } }
function formatNumber(value) { return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function formatPercent(value) { return `${formatNumber(value)}%`; }
function quotaCount(quota) {
  if (!quota || !Number.isFinite(quota.remainingDollars) || !Number.isFinite(quota.limitDollars)) return '';
  return `$${formatNumber(quota.remainingDollars)} left of $${formatNumber(quota.limitDollars)}`;
}
function formatDate(value) { return value ? new Date(value).toLocaleString() : 'unknown'; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

updateFields();
load();
setInterval(load, 60_000);
