rmdir /S /Q release-win
rmdir /S /Q release
rmdir /S /Q node_modules
npm install
electron-rebuild
npm run package-win64
npm run installer-win64
#electron-packager ./ --platform=win32 --arch=x64 --icon=app/favicon.ico --out=release/ergoapp
#node build.js