async function showJson(url, elementId) {
  const out = document.getElementById(elementId);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
    out.className = 'ok';
  } catch (err) {
    out.textContent = `${url} failed: ${err.message}`;
    out.className = 'error';
  }
}

showJson('/api/health', 'health');
showJson('/api/models', 'models');
