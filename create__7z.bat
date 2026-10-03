@echo off
7z a photoeditor.7z ^
-x!.git ^
-x!*.7z ^
-x!*.tar ^
-x!*.rar ^
-x!*.gz ^
-x!*.bat ^
-x!.idea ^
-x!*.log ^
-x!*.css ^
-x!*.map ^
-x!package.json ^
-x!photoeditor.code-workspace ^
-x!vitest.config.js ^
-x!photoeditor.test.js ^
. ^
\Data\_cms\jscript\common.js.src\fileInput.plugin.js ^
\Data\_cms\jscript\common.js.src\photoEditContent.js ^
\Data\_cms\main\photoedit