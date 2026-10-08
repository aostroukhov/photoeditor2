/**
 * CardList — горизонтальный список карточек (наброски, области, история).
 *
 * Один делегированный обработчик на список, клавиатура (Enter/Space — выбрать,
 * Delete/Backspace — удалить), role="listbox"/"option", aria-selected,
 * прокрутка к выбранной карточке. Использует существующие стили
 * .draw-sketch-card*.
 *
 *   const list = new CardList(listEl, {
 *     getId:    (item) => item.id,
 *     render:   (item) => ({ thumbSrc, color, title }),   // данные карточки
 *     onSelect: (item) => …,
 *     onDelete: (item) => …,
 *     ariaLabel: 'Наброски',
 *   });
 *   list.render(items, selected);      // полная перестройка
 *   list.setActive(selected);          // только подсветка
 *   list.updateThumbs(items);          // обновить миниатюры/цвет без перестройки
 */

import { escapeHtml, safeCssColor } from './utils.js';

export class CardList {

  constructor(listEl, { getId, render, onSelect, onDelete, ariaLabel = '' }) {
    this.el       = listEl;
    this.getId    = getId;
    this.renderFn = render;
    this.onSelect = onSelect;
    this.onDelete = onDelete;
    this._items   = [];

    listEl.setAttribute('role', 'listbox');
    if (ariaLabel) listEl.setAttribute('aria-label', ariaLabel);

    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.draw-sketch-card');
      const item = card && this._byId(card.dataset.cardId);
      if (!item) return;
      if (e.target.closest('.draw-sketch-card__del')) this.onDelete?.(item);
      else this.onSelect?.(item);
    });
    listEl.addEventListener('keydown', (e) => {
      const card = e.target.closest('.draw-sketch-card');
      const item = card && this._byId(card.dataset.cardId);
      if (!item) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onSelect?.(item); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.onDelete?.(item); }
    });
  }

  _byId(id) { return this._items.find(it => String(this.getId(it)) === String(id)) ?? null; }

  /** Полная перестройка списка. items рисуются в обратном порядке (новые — слева). */
  render(items, selected = null) {
    this._items = items.slice();
    this.el.innerHTML = '';
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const { thumbSrc = '', color = '', title = '' } = this.renderFn(item) ?? {};
      const active = item === selected;
      const card = document.createElement('div');
      card.className = 'draw-sketch-card' + (active ? ' is-active' : '');
      card.title     = title;
      card.tabIndex  = 0;
      card.dataset.cardId = String(this.getId(item));
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(active));
      card.innerHTML = `
        <button type="button" class="draw-sketch-card__del" title="Удалить" aria-label="Удалить" tabindex="-1">
          <i class="icon-close" aria-hidden="true"></i>
        </button>
        ${thumbSrc && thumbSrc.startsWith('data:image/')
          ? `<img class="draw-sketch-card__thumb" src="${escapeHtml(thumbSrc)}" alt="" draggable="false">`
          : `<div class="draw-sketch-card__thumb draw-sketch-card__thumb--empty"></div>`}
        <div class="draw-sketch-card__color" style="background:${color ? safeCssColor(color) : 'transparent'}"></div>`;
      this.el.appendChild(card);
    }
    this.scrollTo(selected);
  }

  /** Подсветить выбранную карточку без перестройки. */
  setActive(selected) {
    for (const card of this.el.querySelectorAll('.draw-sketch-card')) {
      const active = this._byId(card.dataset.cardId) === selected;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-selected', String(active));
    }
    this.scrollTo(selected);
  }

  /** Обновить миниатюры и цвет без перестройки DOM. */
  updateThumbs(items) {
    for (const card of this.el.querySelectorAll('.draw-sketch-card')) {
      const item = this._byId(card.dataset.cardId);
      if (!item || !items.includes(item)) continue;
      const { thumbSrc = '', color = '' } = this.renderFn(item) ?? {};
      const img = card.querySelector('.draw-sketch-card__thumb');
      if (img?.tagName === 'IMG' && thumbSrc.startsWith('data:image/')) img.src = thumbSrc;
      const bar = card.querySelector('.draw-sketch-card__color');
      if (bar) bar.style.background = color ? safeCssColor(color) : 'transparent';
    }
  }

  scrollTo(selected) {
    if (!selected) return;
    const card = this.el.querySelector(`.draw-sketch-card[data-card-id="${this.getId(selected)}"]`);
    if (!card) return;
    this.el.scrollTo({ left: Math.max(0, card.offsetLeft - (this.el.clientWidth - card.offsetWidth) / 2), behavior: 'smooth' });
  }

  clear() { this._items = []; this.el.innerHTML = ''; }
}
