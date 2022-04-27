set -e
sh run-upgrade.sh
sh run-tsc.sh
sh run-test.sh

npm version patch --no-git-tag-version
npm publish