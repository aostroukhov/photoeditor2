import { describe, it, expect, beforeEach } from 'vitest';
import { EditorConfig } from '../../EditorConfig.js';

describe('EditorConfig.buildExportFileName', () => {
  it('меняет расширение у оригинального имени', () => {
    expect(EditorConfig.buildExportFileName('photo.JPG', 'png')).toBe('photo.png');
    expect(EditorConfig.buildExportFileName('a.b.c.webp', 'jpeg')).toBe('a.b.c.jpg');
  });

  it('добавляет расширение, если его не было', () => {
    expect(EditorConfig.buildExportFileName('clipboard', 'jpeg')).toBe('clipboard.jpg');
  });

  it('без имени генерирует YYYY-MM-DD_HH-MM.ext', () => {
    expect(EditorConfig.buildExportFileName(null, 'png')).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.png$/);
  });
});

describe('EditorConfig.clearStoredData', () => {
  beforeEach(() => localStorage.clear());

  it('удаляет только ключи редактора и возвращает их число', () => {
    localStorage.setItem(EditorConfig.draw.colorStorageKey, '#fff');
    localStorage.setItem(EditorConfig.export.qualityStorageKey, '90');
    localStorage.setItem('unrelated', '1');
    expect(EditorConfig.clearStoredData()).toBe(2);
    expect(localStorage.getItem('unrelated')).toBe('1');
    expect(EditorConfig.clearStoredData()).toBe(0);
  });
});
