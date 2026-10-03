@echo off
tar -czf photoeditor.tar.gz ^
--exclude=".git" ^
--exclude="*.7z" ^
--exclude="*.tar" ^
--exclude="*.rar" ^
--exclude="*.gz" ^
--exclude="*.bat" ^
--exclude=".idea" ^
--exclude="*.log" ^
--exclude="*.css" ^
--exclude="*.map" ^
--exclude="package.json" ^
--exclude="photoeditor.code-workspace" ^
--exclude="vitest.config.js" ^
--exclude="photoeditor.test.js" ^
C:\Data\_cms\jscript\common.js.src\fileInput.plugin.js ^
.