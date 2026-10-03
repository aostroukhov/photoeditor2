/**
 * DialogManager v1.1
 *
 * Изменения v1.1:
 *  • Панели import/export позиционируются рядом со своей кнопкой в тулбаре
 *    (не в фиксированных углах) — через _positionNearBtn()
 *  • unregister() не вызывает onClose чтобы не провоцировать рекурсию
 *  • closeAll() / closeGroup() корректно работают при unregister во время итерации
 */
export class DialogManager {

  constructor(photoEditor) {
    this.pe      = photoEditor;
    this._panels = new Map(); // id → { el, group, onOpen, onClose, btnSelector }
    this._active = new Set();
  }


  // ── Регистрация ────────────────────────────────────────────────────────────

  /**
   * @param {string}      id
   * @param {HTMLElement} el
   * @param {object}      opts
   *   @param {string}   opts.group       — 'tool' | 'utility' | 'free'
   *   @param {string}   [opts.btnSelector] — CSS-селектор кнопки-активатора
   *                                          для позиционирования панели рядом
   *   @param {Function} [opts.onOpen]
   *   @param {Function} [opts.onClose]
   */
  register(id, el, { group = 'utility', btnSelector, onOpen, onClose } = {}) {
    this._ensureCloseBtn(el, id);
    el.hidden = true;
    el.classList.add('pe-panel');
    this._panels.set(id, { el, group, btnSelector, onOpen, onClose });
  }


  // ── Публичный API ──────────────────────────────────────────────────────────

  open(id) {
    const entry = this._panels.get(id);
    if (!entry) return;

    if (entry.group === 'tool')    this._closeGroup('tool');
    if (entry.group === 'utility') this._closeGroup('utility');

    entry.el.hidden = false;
    entry.el.classList.remove('is-hidden');
    this._active.add(id);

    // Позиционируем рядом с кнопкой если задан селектор
    if (entry.btnSelector) {
      this._positionNearBtn(entry.el, entry.btnSelector);
    }

    entry.onOpen?.();

    // Обновляем --pe-panel-h чтобы изображение уменьшилось под панель
    if (entry.group === 'tool') {
      requestAnimationFrame(() => this._updatePanelH(entry.el));
    }
  }

  close(id) {
    const entry = this._panels.get(id);
    if (!entry) return;
    if (!this._active.has(id)) return; // уже закрыта — не вызываем onClose повторно
    entry.el.hidden = true;
    this._active.delete(id);
    entry.onClose?.();

    // Сбрасываем --pe-panel-h если больше нет открытых tool-панелей
    if (entry.group === 'tool') {
      const hasOpenTool = [...this._active].some(
        aid => this._panels.get(aid)?.group === 'tool'
      );
      if (!hasOpenTool) this._setPanelH(0);
    }
  }

  toggle(id) {
    this._active.has(id) ? this.close(id) : this.open(id);
  }

  closeAll() {
    for (const id of [...this._active]) this.close(id);
  }

  closeGroup(group) {
    this._closeGroup(group);
  }

  /**
   * Разрегистрация — НЕ вызывает onClose (вызывающий код сам управляет состоянием).
   */
  unregister(id) {
    const entry = this._panels.get(id);
    if (!entry) return;
    entry.el.hidden = true;
    this._active.delete(id);
    this._panels.delete(id);
    // onClose намеренно НЕ вызывается — чтобы не спровоцировать рекурсию
  }

  isOpen(id) { return this._active.has(id); }


  // ── Приватные ──────────────────────────────────────────────────────────────

  _closeGroup(group) {
    for (const id of [...this._active]) {
      const entry = this._panels.get(id);
      if (entry?.group === group) this.close(id);
    }
  }

  /**
   * Позиционирует панель над кнопкой-активатором.
   * Выравнивает по горизонтали к центру кнопки, снизу вверх от тулбара.
   */
  _positionNearBtn(el, btnSelector) {
    const btn = this.pe.container?.querySelector(btnSelector);
    if (!btn || !this.pe.container) return;

    // Сбрасываем явные позиции чтобы получить размер
    el.style.left      = '';
    el.style.right     = '';
    el.style.transform = '';

    const btnRect       = btn.getBoundingClientRect();
    const containerRect = this.pe.container.getBoundingClientRect();

    // Центр кнопки относительно контейнера
    const btnCenterX = btnRect.left + btnRect.width / 2 - containerRect.left;

    // Ширина панели (уже отрендерена, hidden=false)
    const panelW = el.offsetWidth || 200;

    // Идеальный left: центр кнопки − половина панели
    let left = btnCenterX - panelW / 2;

    // Не выходить за края контейнера (отступ 8px)
    const margin = 8;
    const maxLeft = containerRect.width - panelW - margin;
    left = Math.max(margin, Math.min(left, maxLeft));

    el.style.left      = left + 'px';
    el.style.right     = 'auto';
    el.style.transform = 'none';
  }

  /**
   * Измеряет высоту панели и выставляет --pe-panel-h на контейнере.
   */
  _updatePanelH(el) {
    if (!this.pe.container) return;
    this._setPanelH(el.offsetHeight || 0);
  }

  _setPanelH(px) {
    if (!this.pe.container) return;
    this.pe.container.style.setProperty('--pe-panel-h', px ? px + 'px' : '0px');
  }

  /**
   * Добавляет кнопку × в .pe-panel__header если её ещё нет.
   */
  _ensureCloseBtn(el, id) {
    if (el.querySelector('.pe-panel__close')) return;
    const header = el.querySelector('.pe-panel__header');
    if (!header) return;

    // Убираем старые кнопки-самоделки
    header.querySelector('.pe-panel__close-btn')?.remove();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-panel__close';
    btn.setAttribute('aria-label', 'Закрыть');
    btn.innerHTML = '<i class="icon-close" aria-hidden="true"></i>';
    btn.addEventListener('click', () => this.close(id));
    header.appendChild(btn);
  }
}
