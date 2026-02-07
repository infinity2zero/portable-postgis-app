#!/bin/bash
# Build Windows version of Portable PostGIS on macOS
# Usage: ./scripts/build-windows.sh

set -e  # Exit on error

echo "🚀 Building Windows version of Portable PostGIS"
echo "================================================"
echo ""

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "⚠️  Warning: This script is designed for macOS"
    echo "   Building Windows on other platforms may have limitations"
    echo ""
fi

# Step 1: Download Windows binaries
echo "📥 Step 1: Downloading Windows binaries..."
if node scripts/setup-resources.js --target=win; then
    echo "✅ Windows binaries downloaded successfully"
else
    echo "❌ Failed to download Windows binaries"
    exit 1
fi

echo ""

# Step 2: Verify binaries exist
echo "🔍 Step 2: Verifying binary structure..."
MISSING_BINARIES=0

if [ ! -f "bin/win/postgres/bin/postgres.exe" ]; then
    echo "❌ PostgreSQL binary not found"
    MISSING_BINARIES=1
else
    echo "✅ PostgreSQL found"
fi

if [ ! -f "bin/win/python/python.exe" ]; then
    echo "❌ Python binary not found"
    MISSING_BINARIES=1
else
    echo "✅ Python found"
fi

if [ $MISSING_BINARIES -eq 1 ]; then
    echo ""
    echo "❌ Missing required binaries. Cannot proceed."
    exit 1
fi

echo ""

# Step 3: Build Windows app
echo "🔨 Step 3: Building Windows app with electron-builder..."
echo "   This may take a few minutes..."
echo ""

if npm run build -- --win; then
    echo ""
    echo "✅ Build completed successfully!"
else
    echo ""
    echo "❌ Build failed"
    exit 1
fi

echo ""

# Step 4: Show results
echo "📦 Step 4: Build artifacts:"
echo ""

if [ -d "dist" ]; then
    echo "Files in dist/:"
    ls -lh dist/ | grep -E "\.(exe|zip)$" || echo "   (No Windows artifacts found)"
    echo ""
    
    # Count files
    EXE_COUNT=$(find dist -name "*.exe" 2>/dev/null | wc -l | tr -d ' ')
    ZIP_COUNT=$(find dist -name "*.zip" 2>/dev/null | wc -l | tr -d ' ')
    
    echo "Summary:"
    echo "  - Executables (.exe): $EXE_COUNT"
    echo "  - Archives (.zip): $ZIP_COUNT"
    echo ""
    
    if [ $EXE_COUNT -eq 0 ] && [ $ZIP_COUNT -eq 0 ]; then
        echo "⚠️  Warning: No Windows build artifacts found in dist/"
        echo "   Check build output above for errors"
    else
        echo "✅ Windows build artifacts created successfully!"
        echo ""
        echo "📝 Next steps:"
        echo "   1. Copy dist/*.zip or dist/*.exe to a Windows machine or VM"
        echo "   2. Extract/install and test the application"
        echo "   3. Verify PostgreSQL and pgAdmin start correctly"
    fi
else
    echo "❌ dist/ directory not found"
fi

echo ""
echo "✨ Done!"
