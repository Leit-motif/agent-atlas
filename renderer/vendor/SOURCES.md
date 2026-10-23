# Bundled files

`build.mjs` inlines these into every page, so the page loads nothing from the network. Each comes
unchanged from an npm package; the package checksum is npm's published `dist.integrity`.

| File | From | License |
|---|---|---|
| `d3.min.js` | `d3@7.8.5`, `dist/d3.min.js` | ISC (`LICENSE-d3`) |
| `schibsted-grotesk-*.woff2` | `@fontsource-variable/schibsted-grotesk@5.3.0`, `files/` | OFL 1.1 (`LICENSE-schibsted-grotesk`) |
| `jetbrains-mono-*.woff2` | `@fontsource-variable/jetbrains-mono@5.3.0`, `files/` | OFL 1.1 (`LICENSE-jetbrains-mono`) |

`fonts.css` is written for this project from those packages' `wght.css` (latin and latin-ext only).

## Checksums

Packages:

```text
d3@7.8.5                                      sha512-JgoahDG51ncUfJu6wX/1vWQEqOflgXyl4MaHqlcSruTez7yhaRKR9i8VjjcQGeS2en/jnFivXuaIMnseMMt0XA==
@fontsource-variable/schibsted-grotesk@5.3.0  sha512-ndS6H/KICWANchlHF3q4UdZD+xrZ3Ji0rUobIuXlgvDUzDfqZDsVuXPXZb636nJZMHE9zZ9Fmwgqazm8hMB50Q==
@fontsource-variable/jetbrains-mono@5.3.0     sha512-F32xpS2NsGYoQi2ADSkKTgpJj7ozajsGgDJ8woTnqjmIB+dxDIqImjl4pXZVEExu8UFZ2ndhmX18EBS/hdz3Lw==
```

Files (`sha256sum`):

```text
d6b03aefc9f6c44c7bc78713679c78c295028fa914319119e5cc4b4954855b1c  d3.min.js
79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e  jetbrains-mono-latin-ext-wght-normal.woff2
18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e  jetbrains-mono-latin-wght-normal.woff2
ee9eeb232cc1fe7979dad813a570f4b19f1eb4496daf56c94ec9de63abdb2936  schibsted-grotesk-latin-ext-wght-normal.woff2
4c8b93f431d462c696e12b9d6a033feb3394d36e66e781357c496b95d8a75e05  schibsted-grotesk-latin-wght-normal.woff2
```
