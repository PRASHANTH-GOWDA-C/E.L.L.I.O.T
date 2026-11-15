const out = document.getElementById('health');

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
    out.className = 'ok';
  } catch (err) {
    out.textContent = `Health check failed: ${err.message}`;
    out.className = 'error';
  }
}

checkHealth();
