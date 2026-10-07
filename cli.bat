@echo off

echo Running...
npx tsc && node dist/cli/cli.js

if %errorlevel% neq 0 (
    echo Failed!
    pause
) else (
    echo Ran Successfully...
    pause
)