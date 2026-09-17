// Apply a saved theme choice before first paint (avoids a flash of the wrong theme).
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('sbm.theme') || '"system"');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    // storage unavailable: follow the system preference
  }
})();
