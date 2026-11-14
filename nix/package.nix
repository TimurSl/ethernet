{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  electron_44,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
  # Telegram API credentials from https://my.telegram.org. The web client compiles them in and
  # refuses to build without them: `ethernet.override { telegramApiId = "…"; telegramApiHash = "…"; }`
  telegramApiId ? null,
  telegramApiHash ? null,
}:

let
  # Matches `electron` in client/package.json; override `electron_44` to use another build
  electron = electron_44;
  clientDir = ../client;
  packageJson = lib.importJSON (clientDir + "/package.json");
  packageLock = lib.importJSON (clientDir + "/package-lock.json");

  # The lockfile pins GitHub dependencies as git+ssh URLs; fetch them over HTTPS so no SSH key is needed
  githubSshPrefix = "git+ssh://git@github.com/";
  githubFetcherOpts =
    lib.mapAttrs
      (_: module: {
        url =
          "https://github.com/"
          + lib.removePrefix githubSshPrefix (lib.head (lib.splitString "#" module.resolved));
        allRefs = true;
      })
      (
        lib.filterAttrs (
          _: module: lib.hasPrefix githubSshPrefix (module.resolved or "")
        ) packageLock.packages
      );
  hasCredentials = telegramApiId != null && telegramApiHash != null;
in
buildNpmPackage {
  pname = "ethernet";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = clientDir;
    fileset = lib.fileset.difference clientDir (
      lib.fileset.unions (
        map lib.fileset.maybeMissing [
          (clientDir + "/node_modules")
          (clientDir + "/dist")
          (clientDir + "/.cache")
          (clientDir + "/.env")
        ]
      )
    );
  };

  nodejs = nodejs_24;
  # Each lockfile entry is fetched on its own (registry tarballs by their integrity hash),
  # so there is no npmDepsHash to update when dependencies change
  npmDeps = importNpmLock {
    npmRoot = clientDir;
    fetcherOpts = githubFetcherOpts;
  };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmBuildScript = "app:build";

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    APP_ENV = "production";
    TELEGRAM_API_ID = toString telegramApiId;
    TELEGRAM_API_HASH = toString telegramApiHash;
  };

  preBuild = lib.optionalString (!hasCredentials) ''
    echo "ethernet: Telegram API credentials are required to build the client." >&2
    echo "Get them at https://my.telegram.org, then build" >&2
    echo '  ethernet.override { telegramApiId = "…"; telegramApiHash = "…"; }' >&2
    exit 1
  '';

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  # The Electron main process uses only Node built-ins, so no node_modules ship
  installPhase = ''
    runHook preInstall

    appDir=$out/share/ethernet
    mkdir -p $appDir
    cp -r dist electron assets-bundle package.json $appDir/
    # Bundle analysis output, never loaded by the app
    rm -f $appDir/dist/build-stats.json $appDir/dist/statoscope-report.html

    install -Dm644 public/icon-512x512.png $out/share/icons/hicolor/512x512/apps/ethernet.png

    # Settings, themes, plugins and wallpapers live in a writable folder outside the store
    makeWrapper ${lib.getExe electron} $out/bin/ethernet \
      --add-flags $appDir \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}" \
      --run 'export ETHERNET_DATA_DIR="''${ETHERNET_DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/ethernet}"'

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "ethernet";
      desktopName = "Ethernet";
      comment = "Telegram desktop client";
      exec = "ethernet %U";
      icon = "ethernet";
      startupWMClass = "ethernet";
      categories = [
        "Network"
        "Chat"
        "InstantMessaging"
      ];
      mimeTypes = [
        "x-scheme-handler/tg"
        "x-scheme-handler/tonsite"
      ];
    })
  ];

  meta = {
    description = "Customizable Telegram desktop client built on Telegram Web A and Electron";
    homepage = "https://github.com/TimurSl/ethernet";
    license = lib.licenses.gpl3Only;
    mainProgram = "ethernet";
    platforms = lib.platforms.linux;
  };
}
