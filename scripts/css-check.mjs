// Проверяет, что scss/ скомпилирован в layout.css (без учёта sourceMappingURL).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const strip = (s) => s.replace(/\/\*# sourceMappingURL=.*?\*\/\s*$/s, '').trimEnd();
const compiled = execFileSync('npx', ['sass', '--no-source-map', 'scss/layout.scss'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const committed = readFileSync('layout.css', 'utf8');

if (strip(compiled) !== strip(committed)) {
  console.error('layout.css устарел: выполните `npm run css` и закоммитьте результат.');
  process.exit(1);
}
console.log('layout.css соответствует scss/.');
