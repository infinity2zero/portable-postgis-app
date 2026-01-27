const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration(); // Often helps with headless/offscreen capture

app.whenReady().then(async () => {
    console.log('Generating icon...');
    
    const svgPath = path.join(__dirname, '../assets/icon.svg');
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    const base64Svg = Buffer.from(svgContent).toString('base64');
    const dataUrl = `data:image/svg+xml;base64,${base64Svg}`;

    const win = new BrowserWindow({
        width: 1024,
        height: 1024,
        useContentSize: true,
        frame: false,
        transparent: true,
        show: false, // Keep it hidden
        webPreferences: {
            offscreen: true // Use offscreen rendering
        }
    });

    await win.loadURL(dataUrl);

    // Give it a moment to render
    setTimeout(async () => {
        try {
            const image = await win.capturePage();
            const pngBuffer = image.toPNG();
            
            const destPath = path.join(__dirname, '../assets/icon.png');
            fs.writeFileSync(destPath, pngBuffer);
            
            console.log(`Icon generated at: ${destPath}`);
            app.quit();
        } catch (err) {
            console.error('Failed to generate icon:', err);
            app.exit(1);
        }
    }, 1000);
});
