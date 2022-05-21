call run-tsc.bat
call run-test.bat
call npm version patch --no-git-tag-version
call npm publish