#!/bin/bash
echo ""
echo "  त  Starting Tatva AI..."
echo ""

# Get absolute path to the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Ensure log directory exists
mkdir -p "$PROJECT_ROOT/logs"

# Start ChromaDB server
echo "🔷 Starting ChromaDB..."
cd "$PROJECT_ROOT/backend"
chroma run --path ./chroma_db.nosync --port 8000 > "$PROJECT_ROOT/logs/chroma.log" 2>&1 &
CHROMA_PID=$!

# Wait for ChromaDB
CHROMA_SUCCESS=false
for i in {1..30}; do
  if curl -s http://localhost:8000/api/v2/heartbeat | grep -q "heartbeat"; then
    CHROMA_SUCCESS=true
    break
  fi
  echo "Waiting for ChromaDB... (attempt $i/30)"
  sleep 1
done

if [ "$CHROMA_SUCCESS" = false ]; then
  echo "❌ ChromaDB failed to start within 30 seconds."
  kill $CHROMA_PID 2>/dev/null
  exit 1
fi
echo "✅ ChromaDB is ready"

# Start Backend
echo "🔷 Starting Backend..."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
node server.js > "$PROJECT_ROOT/logs/backend.log" 2>&1 &
BACKEND_PID=$!

# Wait for Backend
BACKEND_SUCCESS=false
for i in {1..30}; do
  if curl -s http://localhost:5001/api/health > /dev/null; then
    BACKEND_SUCCESS=true
    break
  fi
  echo "Waiting for Backend... (attempt $i/30)"
  sleep 1
done

if [ "$BACKEND_SUCCESS" = false ]; then
  echo "❌ Backend failed to start within 30 seconds."
  kill $CHROMA_PID $BACKEND_PID 2>/dev/null
  exit 1
fi
echo "✅ Backend is ready"

# Start Frontend
echo "🔷 Starting Frontend..."
cd "$PROJECT_ROOT/frontend"
npm run dev > "$PROJECT_ROOT/logs/frontend.log" 2>&1 &
FRONTEND_PID=$!

echo ""
echo "✅ ChromaDB  → http://localhost:8000 (logs: ./logs/chroma.log)"
echo "✅ Backend   → http://localhost:5001 (logs: ./logs/backend.log)"
echo "✅ Frontend  → http://localhost:5173 (logs: ./logs/frontend.log)"
echo ""
echo "Open http://localhost:5173"
echo "Press Ctrl+C to stop everything"
echo ""

trap "kill $CHROMA_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM
wait
