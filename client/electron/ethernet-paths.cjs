// Папка пользовательских данных Ethernet: настройки, темы, плагины, обои.
//
// По умолчанию — рядом с исполняемым файлом (портативная сборка, AppImage) или корень
// репозитория при запуске из исходников. ETHERNET_DATA_DIR задаёт её явно: так делает
// пакет Nix, где каталог приложения только для чтения.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function resolveDataRoot() {
  if (process.env.ETHERNET_DATA_DIR) {
    const dir = path.resolve(process.env.ETHERNET_DATA_DIR);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.APPIMAGE) return path.dirname(process.env.APPIMAGE);

  const isPackaged = app ? app.isPackaged : false;
  return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
}

module.exports = { ROOT: resolveDataRoot() };
