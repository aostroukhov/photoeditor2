import { describe, it, expect } from 'vitest';
import { isEditableTarget, escapeHtml, safeCssColor } from '../../utils.js';

const ev = (el) => ({ target: el });
const mk = (tag, attrs = {}) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

describe('isEditableTarget', () => {
  it('текстовые поля, textarea, select, range, color — редактируемые', () => {
    expect(isEditableTarget(ev(mk('input')))).toBe(true);
    expect(isEditableTarget(ev(mk('input', { type: 'text' })))).toBe(true);
    expect(isEditableTarget(ev(mk('input', { type: 'range' })))).toBe(true);
    expect(isEditableTarget(ev(mk('input', { type: 'color' })))).toBe(true);
    expect(isEditableTarget(ev(mk('textarea')))).toBe(true);
    expect(isEditableTarget(ev(mk('select')))).toBe(true);
  });
  it('кнопки, чекбоксы, canvas, body — нет', () => {
    expect(isEditableTarget(ev(mk('input', { type: 'button' })))).toBe(false);
    expect(isEditableTarget(ev(mk('input', { type: 'checkbox' })))).toBe(false);
    expect(isEditableTarget(ev(mk('button')))).toBe(false);
    expect(isEditableTarget(ev(mk('canvas')))).toBe(false);
    expect(isEditableTarget(ev(document.body))).toBe(false);
    expect(isEditableTarget(ev(null))).toBe(false);
    expect(isEditableTarget(ev(document))).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('экранирует спецсимволы', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  });
  it('null/undefined → пустая строка, числа → строка', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('safeCssColor', () => {
  it('пропускает hex / rgb / hsl / имена', () => {
    expect(safeCssColor('#fff')).toBe('#fff');
    expect(safeCssColor('#a1b2c3ff')).toBe('#a1b2c3ff');
    expect(safeCssColor('rgba(60, 143, 224, 0.9)')).toBe('rgba(60, 143, 224, 0.9)');
    expect(safeCssColor('tomato')).toBe('tomato');
  });
  it('отбрасывает инъекции в style', () => {
    expect(safeCssColor('red;background:url(x)')).toBe('#ffffff');
    expect(safeCssColor('expression(1)', '#000')).toBe('#000');
    expect(safeCssColor(undefined)).toBe('#ffffff');
  });
});
