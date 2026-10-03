/**
 * Общие утилиты редактора (DOM / строки).
 * Без зависимостей от PhotoEditor — безопасно импортировать из любого модуля.
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'image', 'hidden',
]);

/**
 * true, если событие пришло из элемента, который сам обрабатывает клавиатуру
 * (текстовое поле, textarea, select, range/color, contenteditable).
 * Горячие клавиши редактора и инструментов в таком случае не должны срабатывать.
 *
 * @param {Event} e
 * @returns {boolean}
 */
export function isEditableTarget(e) {
  const t = e?.target;
  if (!t || typeof t.tagName !== 'string') return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.getAttribute('type') || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * Экранирует строку для безопасной вставки в innerHTML (текст и значения атрибутов).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Возвращает строку, если она похожа на безопасный CSS-цвет (hex / rgb(a) / hsl(a) / имя),
 * иначе fallback. Используется перед вставкой пользовательских цветов в style="…".
 * @param {unknown} value
 * @param {string} fallback
 */
export function safeCssColor(value, fallback = '#ffffff') {
  const s = String(value ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,/-]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return fallback;
}
