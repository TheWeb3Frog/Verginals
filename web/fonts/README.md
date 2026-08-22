# Faces

Two, both self-hosted, both latin subsets of the variable font.

| File | Family | Licence |
|---|---|---|
| `bricolage-grotesque-latin.woff2` | Bricolage Grotesque, by Mathieu Triay | SIL Open Font License 1.1 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono, by JetBrains | SIL Open Font License 1.1 |

Both licences permit redistribution, including bundled with a website, and both are reproduced in
full at the projects themselves:

- https://github.com/ateliertriay/bricolage
- https://github.com/JetBrains/JetBrainsMono

They are served from here rather than from a font CDN for two reasons. The content security policy
is `default-src 'self'` and would refuse a third-party host anyway. The better reason is that a site
whose whole claim is that nothing about you leaves your device should not open a connection to
somebody else's server in order to draw its own headline.
