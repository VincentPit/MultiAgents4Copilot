#!/bin/bash
# Quick package + reinstall for Multi-Agent Copilot
cd "$(dirname "$0")"
npx @vscode/vsce package --no-dependencies --allow-missing-repository --allow-package-secrets github <<< "y" && \
code --install-extension multi-agent-copilot-0.7.0.vsix --force
