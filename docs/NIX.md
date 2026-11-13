# Nix package

The repository is a flake. It exports `packages.<system>.default` (also `.ethernet`), an `overlays.default`
that adds `pkgs.ethernet`, a dev shell, and `formatter`. Linux only (`x86_64-linux`, `aarch64-linux`).

## Telegram API credentials

The client compiles your Telegram API id and hash in, and its build refuses to run without them. Get them at
[my.telegram.org](https://my.telegram.org) and pass them with `override`. Without them the build stops right away
and says so.

The credentials end up in the built JavaScript in `/nix/store`, which every user on the machine can read, as with
any build of the client.

## NixOS

```nix
{
  inputs.ethernet.url = "github:TimurSl/ethernet";

  outputs = { nixpkgs, ethernet, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      modules = [
        ({ pkgs, ... }: {
          environment.systemPackages = [
            (ethernet.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
              telegramApiId = "1234567";
              telegramApiHash = "0123456789abcdef0123456789abcdef";
            })
          ];
        })
      ];
    };
  };
}
```

With the overlay instead: add `ethernet.overlays.default` to `nixpkgs.overlays`, then use
`pkgs.ethernet.override { … }`. Home Manager works the same way through `home.packages`.

## One-off build or run

```bash
nix build --impure --expr '(builtins.getFlake "github:TimurSl/ethernet").packages.x86_64-linux.default.override { telegramApiId = "1234567"; telegramApiHash = "0123456789abcdef0123456789abcdef"; }'
```

```bash
./result/bin/ethernet
```

## Where data lives

The app itself is read-only in the store, so settings, themes, plugins and wallpapers go to
`$XDG_DATA_HOME/ethernet` (usually `~/.local/share/ethernet`). Set `ETHERNET_DATA_DIR` to put them elsewhere. The
default theme and settings are copied there on first start. Electron's own profile (session, cache) stays in
`~/.config/ethernet`.

On Wayland, set `NIXOS_OZONE_WL=1` to run natively instead of through XWayland.

## Maintenance

- **Dependencies** are read from `client/package-lock.json` with `importNpmLock`: each package is fetched by the
  integrity hash in the lockfile, so there is no `npmDepsHash` to update when dependencies change. GitHub
  dependencies pinned as `git+ssh` are fetched over HTTPS, so no SSH key is needed.
- **Electron** is `electron_44` from nixpkgs, matching `client/package.json`. When the client moves to a new major
  version, change it in `nix/package.nix`.
- **nixpkgs**: `nix flake update`.
- **Dev shell**: `nix develop` gives Node 24 and Electron 44; `npm run app` then uses the Nix Electron instead of
  downloading one.
