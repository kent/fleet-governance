const $ = id => document.getElementById(id);
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json' } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed.');
  return value;
}
async function refresh() {
  const data = await api('/api/mcp-tokens');
  $('tokens').replaceChildren();
  for (const item of data.tokens) {
    const row = document.createElement('p');
    row.textContent = `${item.label} · expires ${new Date(item.expiresAt).toLocaleString()} `;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Revoke';
    button.onclick = async () => { try { await api(`/api/mcp-tokens/${item.id}`, { method: 'DELETE' }); await refresh(); } catch (error) { $('message').textContent = error.message; } };
    row.append(button); $('tokens').append(row);
  }
}
$('credential-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const value = await api('/api/mcp-tokens', { method: 'POST', body: JSON.stringify({ label: $('label').value, hours: Number($('hours').value) }) });
    $('credential').value = value.token; $('connection').hidden = false; $('message').textContent = 'Credential created. Copy it before leaving this page.'; await refresh();
  } catch (error) { $('message').textContent = error.message; } finally { button.disabled = false; }
};
$('copy').onclick = async () => { await navigator.clipboard.writeText($('credential').value); $('message').textContent = 'Credential copied.'; };
refresh().catch(error => { $('message').textContent = error.message; });

$('check').onclick = async () => {
  $('check').disabled = true;
  try {
    const result = await api('/api/mcp-check', { method: 'POST', body: JSON.stringify({ token: $('credential').value }) });
    $('check-result').textContent = `Connected through the live MCP endpoint. ${result.toolCount} tools available. $${result.maxRunBudgetUsd} per-run ceiling; $${result.modelPoolUsd} provider pool. No experiments launched.`;
  } catch (error) { $('check-result').textContent = error.message; } finally { $('check').disabled = false; }
};
