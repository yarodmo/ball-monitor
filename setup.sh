#!/bin/bash
# ================================================================
# Florida Lottery Monitor — VPS Setup Script
# Run as: bash setup.sh
# ================================================================

set -e

echo "🚀 Florida Lottery Monitor — Setup"
echo "==================================="

# ── 1. Node.js (via nvm) ─────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
else
  echo "✅ Node.js $(node -v) already installed"
fi

# ── 2. yt-dlp ────────────────────────────────────────────────────
if ! command -v yt-dlp &> /dev/null; then
  echo "📦 Installing yt-dlp..."
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
else
  echo "✅ yt-dlp $(yt-dlp --version) already installed"
  echo "⬆️  Updating yt-dlp..."
  sudo yt-dlp -U
fi

# ── 3. ffmpeg ─────────────────────────────────────────────────────
if ! command -v ffmpeg &> /dev/null; then
  echo "📦 Installing ffmpeg..."
  if command -v apt-get &> /dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y ffmpeg
  elif command -v yum &> /dev/null; then
    sudo yum install -y ffmpeg
  else
    echo "⚠️  Please install ffmpeg manually: https://ffmpeg.org/download.html"
  fi
else
  echo "✅ ffmpeg $(ffmpeg -version 2>&1 | head -1) already installed"
fi

# ── 4. PM2 ───────────────────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  npm install -g pm2
else
  echo "✅ PM2 $(pm2 -v) already installed"
fi

# ── 5. Project dependencies ──────────────────────────────────────
echo "📦 Installing project dependencies..."
npm install

# ── 6. Create directories ────────────────────────────────────────
mkdir -p captures logs config

# ── 7. State file ────────────────────────────────────────────────
if [ ! -f config/state.json ]; then
  echo '{"processedVideos":[]}' > config/state.json
  echo "✅ State file created"
fi

# ── 8. Config check ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚙️  NEXT STEP: Edit config/config.json"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Set your SMTP credentials (Gmail App Password)"
echo "  Verify recipient list"
echo ""
echo "  Then start the monitor:"
echo "  npm run pm2:start"
echo ""
echo "  Check status:"
echo "  curl http://localhost:3456"
echo ""
echo "  View logs:"
echo "  npm run pm2:logs"
echo ""
echo "✅ Setup complete!"
