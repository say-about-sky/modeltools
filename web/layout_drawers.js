// 可折叠 / 可拖动缩放的调试器布局（左侧模型栏、右侧属性栏、底部运行日志）。
// 唯一状态源保存在 localStorage，刷新页面后恢复；不依赖 app.js 的渲染状态。

const STORE_KEY = 'g3dweb.layout.v2';
const DEFAULTS = {
  sidebarW: 268,
  inspectorW: 328,
  bottomH: 196,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  bottomCollapsed: false,
  tabsCollapsed: false,
  listCollapsed: false,
};

const LIMITS = {
  sidebar: [180, 560],
  inspector: [240, 620],
  bottom: [96, 600],
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadState() {
  const out = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return out;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return out;
    out.sidebarW = numberOr(saved.sidebarW, out.sidebarW);
    out.inspectorW = numberOr(saved.inspectorW, out.inspectorW);
    out.bottomH = numberOr(saved.bottomH, out.bottomH);
    for (const key of ['sidebarCollapsed', 'inspectorCollapsed', 'bottomCollapsed', 'tabsCollapsed', 'listCollapsed']) {
      if (typeof saved[key] === 'boolean') out[key] = saved[key];
    }
  } catch {
    // 隐私模式 / 损坏的 localStorage：使用默认布局
  }
  return out;
}

function maxSidebar(state) {
  const room = window.innerWidth
    - (state.inspectorCollapsed ? 0 : state.inspectorW)
    - 300;
  return Math.max(LIMITS.sidebar[0], Math.min(LIMITS.sidebar[1], room));
}

function maxInspector(state) {
  const room = window.innerWidth
    - (state.sidebarCollapsed ? 0 : state.sidebarW)
    - 300;
  return Math.max(LIMITS.inspector[0], Math.min(LIMITS.inspector[1], room));
}

function maxBottom() {
  return Math.max(LIMITS.bottom[0], Math.min(LIMITS.bottom[1], window.innerHeight - 180));
}

function clampState(state) {
  state.sidebarW = clamp(state.sidebarW, LIMITS.sidebar[0], maxSidebar(state));
  state.inspectorW = clamp(state.inspectorW, LIMITS.inspector[0], maxInspector(state));
  state.bottomH = clamp(state.bottomH, LIMITS.bottom[0], maxBottom());
  return state;
}

export function initLayoutDrawers() {
  const app = document.getElementById('app');
  const main = document.getElementById('main');
  const sidebar = document.getElementById('sidebar');
  const inspector = document.getElementById('inspector');
  const bottom = document.getElementById('bottom');
  if (!app || !main || !sidebar || !inspector || !bottom) return null;

  const state = clampState(loadState());
  let drag = null;

  const ui = {
    tabsToggle: document.getElementById('btn-tabs-toggle'),
    listToggle: document.getElementById('btn-list-toggle'),
    sidebarClose: document.getElementById('btn-sidebar-collapse'),
    inspectorClose: document.getElementById('btn-inspector-collapse'),
    bottomClose: document.getElementById('btn-bottom-collapse'),
    sidebarOpen: document.getElementById('sidebar-open'),
    inspectorOpen: document.getElementById('inspector-open'),
    bottomOpen: document.getElementById('bottom-open'),
    sidebarHandle: document.getElementById('sidebar-resizer'),
    inspectorHandle: document.getElementById('inspector-resizer'),
    bottomHandle: document.getElementById('bottom-resizer'),
  };

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      // 忽略无 localStorage 的环境
    }
  }

  function setToggleState(button, expanded, label) {
    if (!button) return;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (label) button.title = label;
  }

  function apply() {
    clampState(state);
    app.style.setProperty('--sidebar-w', `${Math.round(state.sidebarW)}px`);
    app.style.setProperty('--inspector-w', `${Math.round(state.inspectorW)}px`);
    main.style.setProperty('--bottom-h', `${Math.round(state.bottomH)}px`);

    app.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    app.classList.toggle('inspector-collapsed', state.inspectorCollapsed);
    app.classList.toggle('bottom-collapsed', state.bottomCollapsed);
    sidebar.classList.toggle('tabs-collapsed', state.tabsCollapsed);
    sidebar.classList.toggle('list-collapsed', state.listCollapsed);

    sidebar.setAttribute('aria-hidden', state.sidebarCollapsed ? 'true' : 'false');
    inspector.setAttribute('aria-hidden', state.inspectorCollapsed ? 'true' : 'false');
    bottom.setAttribute('aria-hidden', state.bottomCollapsed ? 'true' : 'false');

    setToggleState(ui.sidebarClose, !state.sidebarCollapsed, '收起模型栏');
    setToggleState(ui.inspectorClose, !state.inspectorCollapsed, '收起动画状态 / 属性栏');
    setToggleState(ui.bottomClose, !state.bottomCollapsed, '收起运行日志');
    setToggleState(ui.tabsToggle, !state.tabsCollapsed, state.tabsCollapsed ? '展开模型标签' : '折叠模型标签');
    setToggleState(ui.listToggle, !state.listCollapsed, state.listCollapsed ? '展开模型列表' : '折叠模型列表');
  }

  function setCollapsed(kind, collapsed, persist = true) {
    const key = `${kind}Collapsed`;
    if (!(key in state)) return;
    state[key] = !!collapsed;
    apply();
    if (persist) save();
  }

  function toggle(kind) {
    setCollapsed(kind, !state[`${kind}Collapsed`]);
  }

  function setWidth(kind, value, persist = true) {
    if (kind === 'sidebar') state.sidebarW = Math.round(numberOr(value, state.sidebarW));
    else if (kind === 'inspector') state.inspectorW = Math.round(numberOr(value, state.inspectorW));
    else if (kind === 'bottom') state.bottomH = Math.round(numberOr(value, state.bottomH));
    else return;
    apply();
    if (persist) save();
  }

  function resetWidths() {
    state.sidebarW = DEFAULTS.sidebarW;
    state.inspectorW = DEFAULTS.inspectorW;
    state.bottomH = DEFAULTS.bottomH;
    apply();
    save();
  }

  function beginDrag(kind, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startValue = kind === 'sidebar'
      ? state.sidebarW
      : kind === 'inspector' ? state.inspectorW : state.bottomH;
    drag = { kind, startX, startY, startValue, pointerId: event.pointerId };
    document.body.classList.add('layout-resizing');
    document.body.classList.toggle('is-horizontal', kind === 'bottom');
    event.currentTarget.classList.add('active');
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 某些浏览器/触摸场景不支持指针捕获；window 上仍有 pointerup 兜底
    }

    const move = (ev) => {
      if (!drag) return;
      if (drag.kind === 'sidebar') {
        const next = drag.startValue + (ev.clientX - drag.startX);
        state.sidebarW = Math.round(clamp(next, LIMITS.sidebar[0], maxSidebar(state)));
      } else if (drag.kind === 'inspector') {
        const next = drag.startValue - (ev.clientX - drag.startX);
        state.inspectorW = Math.round(clamp(next, LIMITS.inspector[0], maxInspector(state)));
      } else {
        const next = drag.startValue - (ev.clientY - drag.startY);
        state.bottomH = Math.round(clamp(next, LIMITS.bottom[0], maxBottom()));
      }
      apply();
    };

    const end = () => {
      if (!drag) return;
      const pointerId = drag.pointerId;
      const handle = drag.kind === 'sidebar'
        ? ui.sidebarHandle
        : drag.kind === 'inspector' ? ui.inspectorHandle : ui.bottomHandle;
      handle?.classList.remove('active');
      try {
        if (pointerId != null) handle?.releasePointerCapture?.(pointerId);
      } catch {
        // 指针捕获已释放
      }
      drag = null;
      document.body.classList.remove('layout-resizing', 'is-horizontal');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      save();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function bindHandle(handle, kind) {
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => beginDrag(kind, event));
    handle.addEventListener('dblclick', resetWidths);
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 48 : 16;
      if (kind === 'bottom') {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? step : -step;
        setWidth(kind, state.bottomH + delta);
      } else {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const current = kind === 'sidebar' ? state.sidebarW : state.inspectorW;
        // 右侧栏拖动方向与箭头方向相反：右箭头变窄，左箭头变宽。
        const delta = kind === 'sidebar' ? direction * step : direction * -step;
        setWidth(kind, current + delta);
      }
    });
  }

  bindHandle(ui.sidebarHandle, 'sidebar');
  bindHandle(ui.inspectorHandle, 'inspector');
  bindHandle(ui.bottomHandle, 'bottom');

  ui.sidebarClose?.addEventListener('click', () => setCollapsed('sidebar', true));
  ui.inspectorClose?.addEventListener('click', () => setCollapsed('inspector', true));
  ui.bottomClose?.addEventListener('click', () => setCollapsed('bottom', true));
  ui.sidebarOpen?.addEventListener('click', () => setCollapsed('sidebar', false));
  ui.inspectorOpen?.addEventListener('click', () => setCollapsed('inspector', false));
  ui.bottomOpen?.addEventListener('click', () => setCollapsed('bottom', false));
  ui.tabsToggle?.addEventListener('click', () => {
    state.tabsCollapsed = !state.tabsCollapsed;
    apply();
    save();
  });
  ui.listToggle?.addEventListener('click', () => {
    state.listCollapsed = !state.listCollapsed;
    apply();
    save();
  });

  window.addEventListener('resize', () => {
    clampState(state);
    apply();
  });

  apply();

  // 调试 / AI 自动化用：读取或调整抽屉，不需要模拟拖拽。
  window.__g3dwebLayout = {
    get state() {
      return { ...state };
    },
    setWidth,
    collapse: (kind) => setCollapsed(kind, true),
    expand: (kind) => setCollapsed(kind, false),
    toggle,
    toggleTags: () => {
      state.tabsCollapsed = !state.tabsCollapsed;
      apply();
      save();
    },
    toggleList: () => {
      state.listCollapsed = !state.listCollapsed;
      apply();
      save();
    },
    reset: () => {
      Object.assign(state, DEFAULTS);
      apply();
      save();
    },
  };

  return window.__g3dwebLayout;
}
