(() => {
  'use strict';
  function isCodeURL(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://claude.ai' && /^\/epitaxy(?:\/(?!(?:settings|preferences|projects|artifacts|search|recents)(?:\/|$))[A-Za-z0-9_-]+)?\/?$/.test(url.pathname);
    } catch { return false; }
  }
  function isChatURL(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://claude.ai' && (/^\/(?:new\/?)?$/.test(url.pathname) || /^\/chat\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || isCodeURL(value));
    } catch { return false; }
  }
  self.CztChatScope = { isChatURL, isCodeURL };
})();
