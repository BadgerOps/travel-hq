{
  description = "Travel HQ — local-first dashboard for cards, points, credits, and trips";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        default = travel-hq;

        # Static site build. Output is the contents of dist/ — index.html at $out/index.html,
        # hashed bundles under $out/assets/ — so it can be served directly as an nginx root.
        travel-hq = pkgs.buildNpmPackage {
          pname = "travel-hq";
          version = "0.1.0";

          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter =
              path: _type:
              !(builtins.elem (baseNameOf path) [
                "node_modules"
                "dist"
                "result"
                ".direnv"
              ]);
          };

          # Regenerate after changing package-lock.json:
          #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-jGQfxlcS3snjVrAUly0aW57sC2erL2kA9YFUBaNf/a0=";

          nodejs = pkgs.nodejs_22;

          # Vite emits to dist/; there is nothing to `npm install` in the node sense.
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist/. $out/
            runHook postInstall
          '';

          meta = {
            description = "Local-first travel, points, and credit-card dashboard";
            homepage = "https://forgejo.badger.lan/BadgerOps/travel-hq";
            platforms = pkgs.lib.platforms.unix;
          };
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.typescript-language-server
            # Used to refresh npmDepsHash above after dependency changes.
            pkgs.prefetch-npm-deps
          ];

          shellHook = ''
            echo "travel-hq dev shell — node $(node -v)"
            echo ""
            echo "  npm install && npm run build"
            echo "  npm run dev            # wrangler dev — API + SPA on http://localhost:8787"
            echo ""
            echo "  Needs a .dev.vars (ENCRYPTION_KEY, TRAVEL_HQ_ENV=development,"
            echo "  TRAVEL_HQ_DEV_EMAIL) and a seeded local D1 — see README 'Run locally'."
          '';
        };
      });
    };
}
