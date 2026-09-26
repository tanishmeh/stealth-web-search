// Stealth Web Search website: theme toggle, copy buttons, tabs, docs navigation, image zoom.
(() => {
  const root = document.documentElement;
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // private mode or blocked storage: the choice lasts for this page only
      }
    },
  };

  // theme: follows the system until the visitor picks one
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      store.set('sws-theme', next);
    });
  }

  // copy buttons: the text of the code block (or of the element named by data-copy)
  for (const btn of document.querySelectorAll('.copy')) {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : btn.closest('.code, .terminal')?.querySelector('pre');
      if (!target) return;
      const text = [...target.querySelectorAll('[data-cmd]')].map((el) => el.textContent).join('\n') || target.textContent;
      try {
        await navigator.clipboard.writeText(text.replace(/\n$/, ''));
        const label = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = label;
          btn.classList.remove('done');
        }, 1600);
      } catch {
        btn.textContent = 'Press Ctrl+C';
      }
    });
  }

  // tabs (role=tablist): arrow keys move between tabs
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (step) {
          e.preventDefault();
          select(tabs[(i + step + tabs.length) % tabs.length], true);
        }
      });
    });
  }

  // docs: collapsible navigation on small screens
  const sidebar = document.getElementById('sidebar');
  const toggle = sidebar?.querySelector('.side-toggle');
  toggle?.addEventListener('click', () => {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  // docs: highlight the section being read in "On this page"
  const tocLinks = [...document.querySelectorAll('.toc a')];
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
        const first = [...byId.keys()].find((id) => visible.has(id));
        if (!first) return;
        for (const a of tocLinks) a.classList.toggle('active', a === byId.get(first));
      },
      { rootMargin: '-70px 0px -65% 0px' },
    );
    for (const id of byId.keys()) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
  }

  // screenshots open full size
  for (const link of document.querySelectorAll('a.zoom')) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      const box = document.createElement('button');
      box.className = 'lightbox';
      box.type = 'button';
      box.setAttribute('aria-label', 'Close the image');
      const img = document.createElement('img');
      img.src = link.href;
      img.alt = link.querySelector('img')?.alt ?? '';
      box.append(img);
      const close = () => {
        box.remove();
        document.removeEventListener('keydown', onKey);
        link.focus();
      };
      const onKey = (ev) => ev.key === 'Escape' && close();
      box.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      document.body.append(box);
      box.focus();
    });
  }
})();
