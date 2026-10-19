(() => {
  window.__irisErrors = [];
  window.addEventListener('error', event => window.__irisErrors.push(event.message));
  let preference = 'system';
  try { preference = localStorage.getItem('duet-theme') || 'system'; } catch { /* system default */ }
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { document.documentElement.classList.add('theme-switching'); document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference; document.documentElement.dataset.themePreference = preference; requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('theme-switching'))); };
  window.duetTheme = { get: () => preference, set: value => { preference = ['light','dark','system'].includes(value) ? value : 'system'; localStorage.setItem('duet-theme', preference); apply(); } };
  system.addEventListener('change', apply); apply();
})();
