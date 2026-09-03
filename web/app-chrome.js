// Mounts the site bar on the app.
//
// A separate file rather than an inline tag, because the policy is default-src 'self' with no
// script-src of its own, so an inline script is refused outright. And a separate file rather than an
// import inside app.js, because app.js is a classic script: an `import` statement there is a parse
// error that takes the whole application down before a line of it runs.
//
// The app's twelve-item tab strip stays in the document. Every hash link and every in-page shortcut
// routes by clicking one of those buttons, so deleting the strip would break every deep link on the
// site. It is only no longer drawn: the bar above reaches all of it, where the bar it replaces
// reached three.
import { mountChrome } from '/vgnav.js?v=39';

mountChrome({ active: null });
